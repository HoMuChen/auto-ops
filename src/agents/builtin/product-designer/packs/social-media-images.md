---
key: socialMediaImages
name: Social Media Image Specs
version: 1
---

## Platform Ratios

| Platform | Placement | Ratio | Pixels | Notes |
|----------|-----------|-------|--------|-------|
| Instagram | Feed square | 1:1 | 1080×1080 | Safe for all feed types |
| Instagram | Feed portrait | 4:5 | 1080×1350 | More screen real estate |
| Instagram | Stories / Reels | 9:16 | 1080×1920 | Full screen vertical |
| Facebook | Feed / Ad | 1.91:1 | 1200×628 | Landscape, wide crop |
| LINE | VOOM / Timeline | 1:1 | 1040×1040 | Square preferred |

## Safe Zones

- **9:16 Stories**: keep key content in centre 1080×1420px — top/bottom 250px may be clipped by UI
- **1.91:1 Facebook**: text within 80% of width; edges risk crop on mobile
- **4:5 Instagram**: no safe-zone issue, full bleed is fine

## Copy Placement

When generating images with text overlay:
- Centre-bottom third for 1:1 and 4:5
- Centre frame (avoid top/bottom) for 9:16
- Keep text area contrast ≥ 4.5:1 (WCAG AA) — use solid colour band or semi-transparent overlay

## Prompt Additions for Social

- 1:1: append `"square composition, 1:1 aspect ratio"`
- 4:5: append `"portrait composition, 4:5 aspect ratio, vertical framing"`
- 9:16: append `"vertical full-bleed, 9:16 aspect ratio, subject centred in middle third"`
- 1.91:1: append `"wide landscape, 1.91:1 aspect ratio, subject left-of-centre"`
