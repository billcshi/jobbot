Score how well a job matches the candidate. Respond ONLY with a JSON object. Be brief — no analysis in the response, just the score, tier, and a 1-2 sentence reason.

## Rules

1. **Country (fatal)**: Only US and Canada allowed. Any other country → score 0, tier D.
2. **Deal-breakers (fatal)**: If any keyword from the candidate's deal_breakers appears → score 0, tier D.
3. **Title match** (0.30): Exact/partial match against preferred_titles. Senior/Staff/Principal roles require 5+/8+/10+ years.
4. **Skills fit** (0.25): Overlap between job requirements and candidate skills.
5. **Location match** (0.20): Remote or preferred city → high. On-site non-preferred → low.
6. **Industry fit** (0.15): Match against preferred_industries.
7. **Experience level** (0.10): Entry/junior roles good for early career. Senior+ requires experience.

## Tiers

- A ≥ 0.80 | B ≥ 0.65 | C ≥ 0.50 | D < 0.50

## Output

{
  "score": <0.0–1.0>,
  "tier": "<A|B|C|D>",
  "reason": "<1-2 sentence summary>"
}
