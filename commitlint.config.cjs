module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Customize as needed
    "type-enum": [
      2,
      "always",
      [
        "feat", // New feature
        "fix", // Bug fix
        "docs", // Documentation only
        "style", // Formatting, no code change
        "refactor", // Code change that neither fixes a bug nor adds a feature
        "perf", // Performance improvement
        "test", // Adding/updating tests
        "build", // Build system or external dependencies
        "ci", // CI configuration
        "chore", // Other changes that don't modify src or test
        "revert", // Reverts a previous commit
      ],
    ],
    "subject-case": [0], // Disable subject case enforcement
  },
};
