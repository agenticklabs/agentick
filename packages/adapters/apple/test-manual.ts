/**
 * @agentick/apple — Manual verification tests
 *
 * Run these manually to verify the adapter works on your macOS 26+ system.
 * Automated tests would require Apple Intelligence and can't run in CI.
 */

import { apple } from "./apple.js";

async function testSimpleGeneration() {
  console.log("🧪 Test: Simple text generation");
  const model = apple();

  try {
    const result = await model.execute({
      messages: [{ role: "user", content: "Say hello in one sentence." }],
      system: "You are concise.",
      temperature: 0.7,
      maxTokens: 100,
      stream: false,
    });

    console.log("✅ Result:", result.message.content[0].text);
  } catch (err) {
    console.error("❌ Failed:", err.message);
  }
}

async function testStructuredOutput() {
  console.log("\n🧪 Test: Structured output (person schema)");
  const model = apple();

  try {
    const result = await model.execute({
      messages: [{ role: "user", content: "Generate a fictional person profile" }],
      responseFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          description: "A person profile",
          properties: {
            name: { type: "string", description: "Full name" },
            age: { type: "integer", description: "Age in years" },
            occupation: { type: "string", description: "Job title" },
          },
        },
      },
      stream: false,
    });

    const json = JSON.parse(result.message.content[0].text);
    console.log("✅ Parsed JSON:", json);
    console.log("  - Name:", json.name);
    console.log("  - Age:", json.age);
    console.log("  - Occupation:", json.occupation);
  } catch (err) {
    console.error("❌ Failed:", err.message);
  }
}

async function testNestedStructuredOutput() {
  console.log("\n🧪 Test: Nested structured output (recipe)");
  const model = apple();

  try {
    const result = await model.execute({
      messages: [{ role: "user", content: "Create a simple pasta recipe" }],
      responseFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          description: "A recipe",
          properties: {
            title: { type: "string", description: "Recipe name" },
            calories: { type: "integer", description: "Total calories" },
            nutrition: {
              type: "object",
              description: "Nutritional info",
              properties: {
                protein: { type: "number", description: "Protein in grams" },
                carbs: { type: "number", description: "Carbs in grams" },
                fat: { type: "number", description: "Fat in grams" },
              },
            },
          },
        },
      },
      stream: false,
    });

    const json = JSON.parse(result.message.content[0].text);
    console.log("✅ Parsed JSON:", json);
    console.log("  - Title:", json.title);
    console.log("  - Calories:", json.calories);
    console.log("  - Nutrition:", json.nutrition);
  } catch (err) {
    console.error("❌ Failed:", err.message);
  }
}

async function main() {
  console.log("Apple Foundation Models Adapter — Manual Tests\n");
  console.log("Requirements:");
  console.log("  - macOS 26+");
  console.log("  - Apple Intelligence enabled");
  console.log("  - Model downloaded\n");

  await testSimpleGeneration();
  await testStructuredOutput();
  await testNestedStructuredOutput();

  console.log("\n✨ All tests complete");
}

main().catch(console.error);
