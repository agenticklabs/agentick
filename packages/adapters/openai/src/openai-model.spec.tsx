import { OpenAIModel } from "./openai-model.js";

describe("OpenAIModel Component", () => {
  describe("OpenAIModel factory function", () => {
    it("should create Model component with direct props", () => {
      const element = OpenAIModel({
        apiKey: "test-key",
        model: "gpt-4",
      });
      expect(element).toBeDefined();
      expect(element.type).toBeDefined();
      expect(element.props.model.metadata.id).toBe("openai");
      expect(element.props.model.metadata.provider).toBe("openai");
    });

    it("should create Model component with valid EngineModel", () => {
      const element = OpenAIModel({
        apiKey: "test-key",
        model: "gpt-4",
        temperature: 0.7,
      });

      // Verify it's a valid EngineModel
      expect(element.props.model.generate).toBeDefined();
      expect(element.props.model.stream).toBeDefined();
      expect(element.props.model.fromEngineState).toBeDefined();
      expect(element.props.model.toEngineState).toBeDefined();
    });

    it("should pass through onMount and onUnmount callbacks", () => {
      const onMount = vi.fn();
      const onUnmount = vi.fn();

      const element = OpenAIModel({
        apiKey: "test-key",
        model: "gpt-4",
        onMount,
        onUnmount,
      });
      expect(element.props.onMount).toBe(onMount);
      expect(element.props.onUnmount).toBe(onUnmount);
    });

    it("should accept all OpenAI config options", () => {
      // These config values are passed to OpenAI client internally
      // We can only verify the component accepts them without error
      const element = OpenAIModel({
        apiKey: "test-key",
        model: "gpt-4",
        temperature: 0.7,
        maxTokens: 1000,
        baseURL: "https://my-resource.openai.azure.com",
        organization: "org-123",
        topP: 0.9,
        frequencyPenalty: 0.5,
        presencePenalty: 0.5,
      });

      expect(element).toBeDefined();
      expect(element.props.model.metadata.provider).toBe("openai");
    });
  });

  describe("Integration with Engine", () => {
    it("should create element compatible with Engine", async () => {
      const element = OpenAIModel({
        apiKey: "test-key",
        model: "gpt-4",
      });

      // Verify it produces a valid Model element
      expect(element).toBeDefined();
      expect(element.props.model).toBeDefined();
      expect(typeof element.props.model.generate).toBe("function");
      expect(element.props.model.metadata.model).toBe("gpt-4");
    });
  });
});
