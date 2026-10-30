---
name: request-options
description: When and how to use request_user_options to present clear choices or gather missing facts before running expensive generation steps.
---

# Requesting User Options

Use the `request_user_options` tool to present structured choices or ask clarifying text questions when a human decision is needed before proceeding.

## 1. When to Ask
- The user explicitly asks for options, choices, or suggestions (e.g. "What styles can you make?", "Give me some ideas for this product").
- Essential creative direction or critical parameters are missing before an expensive media generation step (e.g. aspect ratio, visual theme, or video vibe).
- Do NOT ask if the intent is already clear from the conversation history—choose a sensible default and proceed.

## 2. Option Guidelines
- Keep options focused: provide 2 to 4 clear, distinct choices per question.
- Each choice must include:
  - `id`: Short lowercase slug (e.g. `minimalist`, `bold_vibrant`).
  - `label`: Concise, human title (e.g. "Clean Minimalist Studio").
  - `description`: A one-line explanation of the aesthetic, format, or outcome.
  - `recommended`: Mark exactly one recommended option (`recommended: true`) based on best practices.
- For open-ended or missing facts, use a text question (`type: "text"`) with a helpful `placeholder`.

## 3. Execution Rules
- Always call `request_user_options` immediately when options are needed.
- **Never generate media before the user provides an answer.** Do not call image or video tools in the same turn before receiving the user's decision.
- When the user answers or skips, adapt the next turn accordingly: use their selected choices, or continue with the recommended defaults if skipped.
