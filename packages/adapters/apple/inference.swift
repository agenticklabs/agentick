/// Apple Foundation Models Bridge
///
/// A CLI executable that wraps Apple's on-device Foundation Models framework
/// and NaturalLanguage embedding models with a JSON wire protocol compatible
/// with agentick's adapter interface.
///
/// Wire protocol:
///   Input:  JSON on stdin
///   Output: JSON on stdout (ModelOutput for non-streaming, NDJSON AdapterDeltas for streaming)
///
/// Operations:
///   "generate" (default) — text generation via Foundation Models
///   "embed"              — vector embeddings via NLContextualEmbedding
///
/// Build:
///   swiftc -parse-as-library -framework FoundationModels -framework NaturalLanguage inference.swift -o apple-fm-bridge
///
/// Usage:
///   echo '{"messages":[{"role":"user","content":"Hello"}]}' | ./apple-fm-bridge
///   echo '{"operation":"embed","texts":["Hello world"]}' | ./apple-fm-bridge

import Foundation
import FoundationModels
import NaturalLanguage

// ============================================================================
// Wire Protocol Types (aligned with @agentick/shared)
// ============================================================================

// --- Input ---

struct BridgeInput: Decodable {
    let operation: String?  // "generate" (default) or "embed"
    let messages: [WireMessage]?
    let system: String?
    let temperature: Double?
    let maxTokens: Int?
    let stream: Bool?
    let responseFormat: ResponseFormat?
}

// --- Embedding Input ---

struct EmbedInput: Decodable {
    let operation: String
    let texts: [String]
    let script: String?    // "latin" (default), "cyrillic", "cjk", "indic", "thai", "arabic"
    let language: String?  // BCP-47 code, e.g. "en", "fr", "de" — optional, refines results
}

struct EmbedOutput: Encodable {
    let model: String
    let embeddings: [[Double]]
    let dimensions: Int
    let script: String
}

struct ResponseFormat: Decodable {
    let type: String
    let schema: JsonSchema?
    let name: String?
}

struct JsonSchema: Decodable {
    let type: String
    let description: String?
    let properties: [String: SchemaProperty]?
    let items: SchemaProperty?  // For array schemas
}

// Use indirect enum to handle recursion
indirect enum SchemaProperty: Decodable {
    case leaf(type: String, description: String?)
    case object(type: String, description: String?, properties: [String: SchemaProperty])
    case array(type: String, description: String?, items: SchemaProperty)
    
    enum CodingKeys: String, CodingKey {
        case type, description, properties, items
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        let description = try container.decodeIfPresent(String.self, forKey: .description)
        
        if type == "object" {
            let properties = try container.decodeIfPresent([String: SchemaProperty].self, forKey: .properties) ?? [:]
            self = .object(type: type, description: description, properties: properties)
        } else if type == "array" {
            let items = try container.decode(SchemaProperty.self, forKey: .items)
            self = .array(type: type, description: description, items: items)
        } else {
            self = .leaf(type: type, description: description)
        }
    }
    
    var propertyType: String {
        switch self {
        case .leaf(let type, _): return type
        case .object(let type, _, _): return type
        case .array(let type, _, _): return type
        }
    }
    
    var propertyDescription: String? {
        switch self {
        case .leaf(_, let desc): return desc
        case .object(_, let desc, _): return desc
        case .array(_, let desc, _): return desc
        }
    }
}

struct WireMessage: Decodable {
    let role: String
    let content: MessageContent

    enum MessageContent: Decodable {
        case text(String)
        case blocks([ContentBlock])

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let str = try? container.decode(String.self) {
                self = .text(str)
            } else {
                self = .blocks(try container.decode([ContentBlock].self))
            }
        }

        var text: String {
            switch self {
            case .text(let str): return str
            case .blocks(let blocks):
                return blocks
                    .filter { $0.type == "text" }
                    .compactMap { $0.text }
                    .joined(separator: "\n")
            }
        }
    }

    struct ContentBlock: Decodable {
        let type: String
        let text: String?
    }
}

// --- Output (non-streaming, matches ModelOutput) ---

struct BridgeOutput: Encodable {
    let model: String
    let createdAt: String
    let message: OutputMessage
    let stopReason: String
    let usage: WireUsage
}

struct OutputMessage: Encodable {
    let role: String
    let content: [OutputContentBlock]
}

struct OutputContentBlock: Encodable {
    let type: String
    let text: String
}

struct WireUsage: Encodable {
    let inputTokens: Int
    let outputTokens: Int
    let totalTokens: Int
}

// --- Output (streaming, matches AdapterDelta) ---

struct TextDelta: Encodable {
    let type = "text"
    let delta: String
}

struct MessageEnd: Encodable {
    let type = "message_end"
    let stopReason: String
    let usage: WireUsage
}

struct ErrorOutput: Encodable {
    let type = "error"
    let error: String
}

// ============================================================================
// Bridge
// ============================================================================

@main
struct AppleFoundationBridge {
    static let modelId = "apple-foundation-3b"

    static func main() async {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        do {
            try await run(encoder: encoder)
        } catch {
            writeJSON(ErrorOutput(error: String(describing: error)), encoder: encoder)
        }
    }

    static func run(encoder: JSONEncoder) async throws {
        let inputData = FileHandle.standardInput.readDataToEndOfFile()
        guard !inputData.isEmpty else {
            writeJSON(ErrorOutput(error: "No input on stdin"), encoder: encoder)
            return
        }

        // Peek at operation field to route
        struct OperationPeek: Decodable { let operation: String? }
        let peek = try JSONDecoder().decode(OperationPeek.self, from: inputData)

        if peek.operation == "embed" {
            let embedInput = try JSONDecoder().decode(EmbedInput.self, from: inputData)
            try generateEmbeddings(input: embedInput, encoder: encoder)
            return
        }

        // Default: text generation
        let input = try JSONDecoder().decode(BridgeInput.self, from: inputData)

        let model = SystemLanguageModel.default
        guard model.availability == .available else {
            writeJSON(
                ErrorOutput(error: "Model not available: \(model.availability)"),
                encoder: encoder
            )
            return
        }

        let messages = input.messages ?? []

        let systemPrompt = input.system ?? messages
            .filter { $0.role == "system" }
            .map { $0.content.text }
            .joined(separator: "\n")

        let prompt = buildPrompt(from: messages.filter { $0.role != "system" })

        guard !prompt.isEmpty else {
            writeJSON(ErrorOutput(error: "No user messages provided"), encoder: encoder)
            return
        }

        let session = systemPrompt.isEmpty
            ? LanguageModelSession()
            : LanguageModelSession(instructions: systemPrompt)

        if let responseFormat = input.responseFormat, responseFormat.type == "json_schema" {
            if input.stream == true {
                writeJSON(ErrorOutput(error: "Streaming not supported with json_schema response format"), encoder: encoder)
                return
            }
            
            guard let schema = responseFormat.schema else {
                writeJSON(ErrorOutput(error: "json_schema requires schema field"), encoder: encoder)
                return
            }
            
            try await generateStructuredResponse(
                session: session,
                prompt: prompt,
                schema: schema,
                encoder: encoder
            )
        } else if input.stream == true {
            try await streamResponse(session: session, prompt: prompt, encoder: encoder)
        } else {
            try await generateResponse(session: session, prompt: prompt, encoder: encoder)
        }
    }

    // MARK: - Non-streaming

    static func generateResponse(
        session: LanguageModelSession,
        prompt: String,
        encoder: JSONEncoder
    ) async throws {
        let response = try await session.respond(to: prompt)
        let now = ISO8601DateFormatter().string(from: Date())

        let output = BridgeOutput(
            model: modelId,
            createdAt: now,
            message: OutputMessage(
                role: "assistant",
                content: [OutputContentBlock(type: "text", text: response.content)]
            ),
            stopReason: "stop",
            usage: WireUsage(inputTokens: 0, outputTokens: 0, totalTokens: 0)
        )

        writeJSON(output, encoder: encoder)
    }

    // MARK: - Streaming

    static func streamResponse(
        session: LanguageModelSession,
        prompt: String,
        encoder: JSONEncoder
    ) async throws {
        let stream = session.streamResponse(to: prompt)
        var emitted = 0

        for try await partial in stream {
            let content = partial.content
            if content.count > emitted {
                let startIdx = content.index(content.startIndex, offsetBy: emitted)
                let newText = String(content[startIdx...])
                writeLine(TextDelta(delta: newText), encoder: encoder)
                emitted = content.count
            }
        }

        writeLine(
            MessageEnd(
                stopReason: "stop",
                usage: WireUsage(inputTokens: 0, outputTokens: 0, totalTokens: 0)
            ),
            encoder: encoder
        )
    }
    
    // MARK: - Structured Output

    static func generateStructuredResponse(
        session: LanguageModelSession,
        prompt: String,
        schema: JsonSchema,
        encoder: JSONEncoder
    ) async throws {
        // Convert JSON Schema to DynamicGenerationSchema
        let dynamicSchema = try buildDynamicSchema(from: schema)
        let generationSchema = try GenerationSchema(root: dynamicSchema, dependencies: [])
        
        // Generate with schema
        let response = try await session.respond(to: prompt, schema: generationSchema)
        let now = ISO8601DateFormatter().string(from: Date())
        
        // Get JSON string directly from GeneratedContent
        let jsonContent = response.content.jsonString
        
        let output = BridgeOutput(
            model: modelId,
            createdAt: now,
            message: OutputMessage(
                role: "assistant",
                content: [OutputContentBlock(type: "text", text: jsonContent)]
            ),
            stopReason: "stop",
            usage: WireUsage(inputTokens: 0, outputTokens: 0, totalTokens: 0)
        )
        
        writeJSON(output, encoder: encoder)
    }
    
    static func buildDynamicSchema(from jsonSchema: JsonSchema) throws -> DynamicGenerationSchema {
        guard jsonSchema.type == "object" else {
            throw NSError(domain: "AppleFMBridge", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Only object schemas are supported at root level"
            ])
        }
        
        guard let properties = jsonSchema.properties else {
            throw NSError(domain: "AppleFMBridge", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Object schema must have properties"
            ])
        }
        
        let dynamicProperties = try properties.map { (key, prop) -> DynamicGenerationSchema.Property in
            DynamicGenerationSchema.Property(
                name: key,
                description: prop.propertyDescription,
                schema: try buildPropertySchema(from: prop)
            )
        }
        
        return DynamicGenerationSchema(
            name: jsonSchema.description ?? "response",
            description: jsonSchema.description,
            properties: dynamicProperties
        )
    }
    
    static func buildPropertySchema(from prop: SchemaProperty) throws -> DynamicGenerationSchema {
        switch prop {
        case .leaf(let type, _):
            switch type {
            case "string":
                return DynamicGenerationSchema(type: String.self)
            case "integer":
                return DynamicGenerationSchema(type: Int.self)
            case "number":
                return DynamicGenerationSchema(type: Double.self)
            case "boolean":
                return DynamicGenerationSchema(type: Bool.self)
            default:
                throw NSError(domain: "AppleFMBridge", code: 5, userInfo: [
                    NSLocalizedDescriptionKey: "Unsupported property type: \(type)"
                ])
            }
        case .object(_, let description, let nestedProps):
            let dynamicProperties = try nestedProps.map { (key, nestedProp) -> DynamicGenerationSchema.Property in
                DynamicGenerationSchema.Property(
                    name: key,
                    description: nestedProp.propertyDescription,
                    schema: try buildPropertySchema(from: nestedProp)
                )
            }
            return DynamicGenerationSchema(
                name: description ?? "nested",
                description: description,
                properties: dynamicProperties
            )
        case .array(_, _, _):
            // Arrays are not properly supported in DynamicGenerationSchema
            // The API exists but the correct pattern isn't documented
            // For now, recommend using comma-separated strings or numbered properties
            throw NSError(domain: "AppleFMBridge", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "Array types are not supported. Use comma-separated strings or numbered object properties instead."
            ])
        }
    }

    // MARK: - Embeddings

    static func resolveScript(_ name: String?) -> NLScript {
        switch name?.lowercased() {
        case "cyrillic": return .cyrillic
        case "cjk": return .simplifiedChinese  // CJK model
        case "devanagari", "indic": return .devanagari
        case "thai": return .thai
        case "arabic": return .arabic
        default: return .latin
        }
    }

    static func generateEmbeddings(input: EmbedInput, encoder: JSONEncoder) throws {
        guard !input.texts.isEmpty else {
            writeJSON(ErrorOutput(error: "No texts provided for embedding"), encoder: encoder)
            return
        }

        let script = resolveScript(input.script)
        guard let embedding = NLContextualEmbedding(script: script) else {
            writeJSON(ErrorOutput(error: "No embedding model available for script: \(input.script ?? "latin")"), encoder: encoder)
            return
        }

        guard embedding.hasAvailableAssets else {
            writeJSON(ErrorOutput(error: "Embedding model assets not downloaded. Enable Apple Intelligence and ensure the model is available."), encoder: encoder)
            return
        }

        try embedding.load()
        defer { embedding.unload() }

        let dimensions = embedding.dimension
        let language: NLLanguage? = input.language.map { NLLanguage(rawValue: $0) }

        var allEmbeddings: [[Double]] = []

        for text in input.texts {
            let result = try embedding.embeddingResult(for: text, language: language)

            let count = result.sequenceLength
            guard count > 0 else {
                allEmbeddings.append(Array(repeating: 0.0, count: dimensions))
                continue
            }

            // Mean-pool token vectors into a single sentence embedding
            var sum = Array(repeating: 0.0, count: dimensions)
            result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vector, tokenRange in
                for i in 0..<min(vector.count, dimensions) {
                    sum[i] += Double(vector[i])
                }
                return true
            }

            let divisor = Double(count)
            let averaged = sum.map { $0 / divisor }
            allEmbeddings.append(averaged)
        }

        let output = EmbedOutput(
            model: "apple-contextual-embedding",
            embeddings: allEmbeddings,
            dimensions: dimensions,
            script: input.script ?? "latin"
        )
        writeJSON(output, encoder: encoder)
    }

    // MARK: - Prompt Construction

    /// Flatten conversation messages into a single prompt string.
    /// Foundation Models doesn't have a native multi-turn message API,
    /// so we format the conversation as structured text.
    static func buildPrompt(from messages: [WireMessage]) -> String {
        if messages.count == 1 {
            return messages[0].content.text
        }

        var parts: [String] = []
        for msg in messages {
            let text = msg.content.text
            switch msg.role {
            case "user":
                parts.append("User: \(text)")
            case "assistant":
                parts.append("Assistant: \(text)")
            case "tool_result":
                parts.append("Tool Result: \(text)")
            default:
                parts.append("\(msg.role): \(text)")
            }
        }
        return parts.joined(separator: "\n\n")
    }

    // MARK: - Output Helpers

    static func writeJSON<T: Encodable>(_ value: T, encoder: JSONEncoder) {
        guard let data = try? encoder.encode(value) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }

    static func writeLine<T: Encodable>(_ value: T, encoder: JSONEncoder) {
        guard let data = try? encoder.encode(value) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}
