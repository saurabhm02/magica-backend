---
name: video-montage
description: How to sequence video clips, structure narrative pacing, and select transitions for merge_videos.
---

# Video Montage Creation with Merge Videos

When combining multiple video clips into a single cohesive montage using `merge_videos`, apply these sequencing and transition rules.

## 1. Clip Sequencing
- **Hook First**: Place the most visually arresting or high-energy clip in the first 2-3 seconds to capture attention immediately.
- **Narrative Progression**: Order middle clips chronologically or in logical problem-to-solution steps (e.g. establishing shot -> product close-up -> user interaction -> result).
- **Call-to-Action Finale**: End with a brand reveal, end-card, or final payoff shot.

## 2. Transition Selection
The `merge_videos` tool supports three transitions:
- `"none"`: Hard cut. Best for fast-paced social edits, rhythm-based beat matching, action montages, and modern dynamic promos.
- `"fade"`: Fade to black/color between clips. Best for scene changes representing passage of time, mood shifts, or cinematic introductions.
- `"dissolve"`: Cross-dissolve where clips blend smoothly into one another. Best for dream sequences, emotional retrospectives, or continuous ambient visuals.

## 3. Tool Usage Rules
- `video_urls`: Provide between 2 and 100 valid video URLs in exact playback order.
- `transition`: Select one of `"none"`, `"fade"`, or `"dissolve"`. Default is `"none"`.
