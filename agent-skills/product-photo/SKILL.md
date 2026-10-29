---
name: product-photo
description: How to write high-converting gpt_image_2 prompts for commercial product shots, studio lighting, clean backgrounds, quality selection, and edit mode.
---

# Product Photography with GPT Image 2

When generating commercial product photos, follow these principles to produce crisp, studio-grade imagery using `gpt_image_2`.

## 1. Prompt Structure for Product Shots
Always structure your product prompt with these four core elements:
1. **Subject**: The exact product, material, texture, and state (e.g. "a matte ceramic coffee mug with a ribbed texture, filled with steaming black coffee").
2. **Lighting**: Explicit studio lighting setup. Specify "diffused softbox lighting", "rim light separating subject from background", or "soft directional morning light". Avoid harsh unmanaged specular highlights unless highlighting metallic finishes.
3. **Background & Surface**: Clean, controlled surfaces. Specify "sitting on a clean polished concrete surface, subtle soft drop shadow" or "on a smooth off-white marble tabletop, neutral seamless studio background".
4. **Style**: Use "commercial product photography, 85mm lens, shallow depth of field, sharp focus on product".

## 2. Choosing Quality and Size
- **Size**: Default to `"1024x1024"` for standard square product catalog shots.
- **Quality**: Default to `"Medium"`. Use `"High"` only if the user explicitly requests high resolution, maximum fidelity, or ultra-detail.
- **Background**: Keep `"Auto"` for natural ambient studio backgrounds, or specify `"Opaque"` when clean isolation is needed.

## 3. When to Use Edit Mode vs Text Mode
- **Text Mode (`mode: "text"`)**: Use when creating a brand new product visual from a text description from scratch.
- **Edit Mode (`mode: "edit"`)**: Use when the user has provided an existing image URL in `uploadedImages` and wants to modify details (e.g., change color, add logo, adjust surface texture, or swap background) while preserving product geometry.
