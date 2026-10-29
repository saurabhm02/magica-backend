---
name: social-crop
description: Crop sizes and aspect ratio calculations for Instagram post, Instagram story, YouTube thumbnail, and X header.
---

# Social Media Image Cropping

Use this guide when preparing an image for social media publishing using `crop_image`.

## 1. Presets Reference
The asset file `dimensions.json` lists the exact pixel targets and crop percentage recommendations for popular platforms. Use `read_skill_asset` with path `"dimensions.json"` to inspect exact specifications if needed.

Summary of standard platform dimensions:
- **Instagram Story / Reel**: 9:16 vertical ratio (1080x1920). From a 1:1 square source, crop width to 56.25% centered (`x_percent: 21.875, y_percent: 0, width_percent: 56.25, height_percent: 100`).
- **Instagram Post (Square)**: 1:1 ratio (1080x1080). If the source is already square, no crop is needed; otherwise crop to center square.
- **YouTube Thumbnail**: 16:9 widescreen ratio (1280x720). From a square, crop height to 56.25% centered (`x_percent: 0, y_percent: 21.875, width_percent: 100, height_percent: 56.25`).
- **X (Twitter) Header**: 3:1 banner ratio (1500x500). Center crop with `x_percent: 0, y_percent: 33.33, width_percent: 100, height_percent: 33.33`.

## 2. Using `crop_image`
When calling `crop_image`:
1. Provide the source `image_url`.
2. Provide the percentage parameters: `x_percent`, `y_percent`, `width_percent`, `height_percent`.
3. Ensure the focal point (e.g. product or subject) remains in the center safe zone of the cropped area.
