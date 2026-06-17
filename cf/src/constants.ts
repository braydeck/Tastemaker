// Ported from main.py / enrichment.py / cluster.py module-level constants.

export const TMDB_BASE = "https://api.themoviedb.org/3";
export const IGDB_API_URL = "https://api.igdb.com/v4/games";
export const IGDB_TOKEN_URL = "https://id.twitch.tv/oauth2/token";

// Universal dimensions (all media). Games additionally carry sdt_autonomy +
// sdt_competence in psychological_tags but those aren't in this list.
export const DIMENSIONS = [
  "ugt_cognitive", "ugt_affective", "narrative_complexity",
  "tonal_register", "pacing_density",
  "world_building_depth", "character_interiority",
  "moral_architecture", "diegetic_trust", "scope", "humor",
] as const;

export const KNOWN_DIMS = new Set<string>([...DIMENSIONS, "sdt_autonomy", "sdt_competence"]);

export const DIMENSION_LABELS: Record<string, string> = {
  ugt_cognitive: "Intellectual Depth",
  ugt_affective: "Emotional Intensity",
  narrative_complexity: "Narrative Complexity",
  tonal_register: "Dark / Bleak Tone",
  pacing_density: "Dense Pacing",
  world_building_depth: "World-Building Depth",
  character_interiority: "Character Interiority",
  moral_architecture: "Moral Ambiguity",
  diegetic_trust: "Show Don't Tell",
  scope: "Epic Scale",
  humor: "Humor",
  sdt_autonomy: "Agency & Choice",
  sdt_competence: "Mastery & Systems",
};

export const DIMENSION_DEFINITIONS: Record<string, string> = {
  ugt_cognitive: "Rewards intellectual engagement and system-thinking",
  ugt_affective: "Prioritizes emotional experience and mood regulation",
  narrative_complexity: "Structural complexity of plotting and thematic layering",
  tonal_register: "Affective temperature: warm/optimistic ↔ cold/bleak",
  pacing_density: "Information or plot density per unit time or page",
  world_building_depth: "Richness of the fictional world's lore and internal logic",
  character_interiority: "Depth of psychological portrayal and inner life",
  moral_architecture: "Clear good/evil ↔ genuine moral relativism",
  diegetic_trust: "Withholds explanation, trusts audience to infer",
  scope: "Scale of narrative world and stakes",
  humor: "Degree to which comedy is a primary register (1=serious, 5=comedic)",
  sdt_autonomy: "Grants meaningful player agency through branching choices",
  sdt_competence: "Rewards mastery of systems and mechanical depth",
};

// Keyed by tier number; null tier handled separately.
export const TIER_NAMES: Record<string, string> = {
  "1": "Tier 1 — Essential",
  "2": "Tier 2 — Great",
  "3": "Tier 3 — Good",
  "4": "Tier 4 — Fine",
  "5": "Tier 5 — Didn't Work For Me",
};
export const TIER_NAME_UNTIERED = "Untiered";

export function tierName(tier: number | null | undefined): string {
  if (tier == null) return TIER_NAME_UNTIERED;
  return TIER_NAMES[String(tier)] ?? `Tier ${tier}`;
}

export const TIER_BADGE_CLASSES: Record<string, string> = {
  "1": "bg-yellow-500 text-black",
  "2": "bg-slate-400 text-black",
  "3": "bg-amber-600 text-white",
  "4": "bg-neutral-500 text-white",
  "5": "bg-neutral-800 text-neutral-400",
};
export const TIER_BADGE_DEFAULT = "bg-neutral-700 text-neutral-500";

export function tierBadgeClass(tier: number | null | undefined): string {
  if (tier == null) return TIER_BADGE_DEFAULT;
  return TIER_BADGE_CLASSES[String(tier)] ?? TIER_BADGE_DEFAULT;
}

export const MEDIUM_DOT_CLASSES: Record<string, string> = {
  movie: "bg-blue-500",
  tv: "bg-purple-500",
  book: "bg-emerald-500",
  game: "bg-orange-500",
};
export function mediumDot(medium: string | undefined): string {
  return MEDIUM_DOT_CLASSES[medium ?? ""] ?? "bg-neutral-600";
}

export interface QualityFloor {
  score_field: string;
  count_field: string;
  min_score: number;
  min_count: number;
}
export const QUALITY_FLOORS: Record<string, QualityFloor> = {
  movie: { score_field: "vote_average", count_field: "vote_count", min_score: 7.0, min_count: 200 },
  tv: { score_field: "vote_average", count_field: "vote_count", min_score: 7.5, min_count: 100 },
  book: { score_field: "averageRating", count_field: "ratingsCount", min_score: 3.6, min_count: 50 },
  game: { score_field: "rating", count_field: "rating_count", min_score: 75, min_count: 10 },
};

// ---------------------------------------------------------------------------
// Discover prompts (from main.py)
// ---------------------------------------------------------------------------

export const SEED_SYSTEM_PROMPT = `You are a media recommendation engine.
The user enjoys specific titles listed below. Based on those titles and their psychological profiles, recommend 25 titles they have NOT consumed.
Match the style, tone, and qualities that make those seeds compelling.
CRITICAL RULE: The EXCLUDE list contains everything the user has already seen, read, played, or queued. You MUST check every single recommendation against that list before including it. Any title appearing on the EXCLUDE list — even under a slightly different format — must be dropped and replaced with something else. Violating this rule makes the recommendations useless.
IMPORTANT: This user has a large, well-curated library. Do NOT suggest the obvious genre classics — they almost certainly have them. Prioritize deep cuts, underseen works, and non-obvious choices that match the same qualities.
QUALITY: Prefer well-regarded titles — movies/TV above 7/10, books above 3.5/5, games above 75/100 on community aggregators. Avoid panned or critically ignored works.
Return ONLY a valid JSON array — no preamble, no explanation, no markdown.
Return format: [{"title": "...", "medium": "movie|tv|book|game", "reason": "one sentence"}, ...]`;

export const CLUSTER_SYSTEM_PROMPT = `You are a media recommendation engine.
The user has a specific taste facet described below. Recommend 25 titles matching that taste.
CRITICAL RULE: The EXCLUDE list contains everything the user has already seen, read, played, or queued. You MUST check every single recommendation against that list before including it. Any title appearing on the EXCLUDE list — even under a slightly different format — must be dropped and replaced with something else. Violating this rule makes the recommendations useless.
IMPORTANT: This user has a large, well-curated library. Do NOT suggest the obvious genre classics — they almost certainly have them. Prioritize deep cuts, underseen works, and non-obvious choices that match the same qualities.
QUALITY: Prefer well-regarded titles — movies/TV above 7/10, books above 3.5/5, games above 75/100 on community aggregators. Avoid panned or critically ignored works.
Return ONLY a valid JSON array — no preamble, no explanation, no markdown.
Return format: [{"title": "...", "medium": "movie|tv|book|game", "reason": "one sentence"}, ...]`;

export const NAMING_SYSTEM_PROMPT = `You are naming a taste cluster from a personal media library.
You will receive psychological dimension scores for the cluster centroid and a list of example titles.
Return ONLY valid JSON with no preamble, explanation, or markdown fences.
Return format: {"name": "3-5 word evocative name", "description": "Two sentences describing what unifies this taste. Be specific and concrete, not generic."}`;

// ---------------------------------------------------------------------------
// Enrichment tagging prompts (from enrichment.py). {calibration_block} is
// substituted at runtime.
// ---------------------------------------------------------------------------

export const BASE_SYSTEM_PROMPT = `You are a media analysis engine. Your task is to score a given work across
a set of psychological and structural dimensions. You must return ONLY a
valid JSON object — no preamble, no explanation, no markdown.

Score each dimension as a float from 1.0 to 5.0.

Dimension definitions:

ugt_cognitive: Degree to which the work rewards intellectual engagement,
system-thinking, and information processing.
  1.0 = passive, undemanding (comfort TV)
  5.0 = maximally demanding

ugt_affective: Degree to which the work prioritizes emotional experience,
tension, or mood regulation.
  1.0 = emotionally flat
  5.0 = high emotional intensity

narrative_complexity: Structural complexity of plotting, timelines,
unreliable narration, and thematic layering.
  1.0 = linear and simple
  5.0 = maximally complex

tonal_register: Affective temperature of the work.
  1.0 = warm / optimistic / comedic
  5.0 = cold / bleak / nihilistic

pacing_density: Information or plot density per unit time or page.
  1.0 = sparse, meditative
  5.0 = dense, relentless

world_building_depth: Richness and depth of the fictional world.
  1.0 = no world-building; real world or entirely contained setting
  5.0 = richly developed fictional world with deep lore and internal logic

character_interiority: Depth of psychological portrayal and inner life.
  1.0 = characters are functional; minimal psychology or inner life
  5.0 = deep psychological interiority; consciousness and subjectivity are primary

moral_architecture: Structure of the ethical framework.
  1.0 = clear moral universe, unambiguous good vs. evil
  3.0 = morally complex but the work adjudicates
  5.0 = genuinely relativist or nihilist, no authorial adjudication

diegetic_trust: Degree to which the work withholds explanation and
trusts the audience to infer.
  1.0 = over-explains everything
  5.0 = maximally withholding

scope: Scale of the narrative world and stakes.
  1.0 = intimate, small cast, contained stakes
  5.0 = epic, civilizational stakes

humor: Degree to which comedy is a primary register of the work.
  1.0 = entirely serious; no comedic register
  3.0 = mixed; comedy and drama balanced
  5.0 = predominantly comedic; humor is the primary mode

{calibration_block}

Return format (exactly this structure, no other text):
{
  "ugt_cognitive": float,
  "ugt_affective": float,
  "narrative_complexity": float,
  "tonal_register": float,
  "pacing_density": float,
  "world_building_depth": float,
  "character_interiority": float,
  "moral_architecture": float,
  "diegetic_trust": float,
  "scope": float,
  "humor": float
}`;

export const GAME_SYSTEM_PROMPT = `You are a media analysis engine. Your task is to score a given work across
a set of psychological and structural dimensions. You must return ONLY a
valid JSON object — no preamble, no explanation, no markdown.

Score each dimension as a float from 1.0 to 5.0.

Dimension definitions:

ugt_cognitive: Degree to which the work rewards intellectual engagement,
system-thinking, and information processing.
  1.0 = passive, undemanding
  5.0 = maximally demanding

ugt_affective: Degree to which the work prioritizes emotional experience,
tension, or mood regulation.
  1.0 = emotionally flat
  5.0 = high emotional intensity

narrative_complexity: Structural complexity of plotting, timelines,
unreliable narration, and thematic layering.
  1.0 = linear and simple
  5.0 = maximally complex

tonal_register: Affective temperature of the work.
  1.0 = warm / optimistic / light
  5.0 = cold / bleak / nihilistic

pacing_density: Information or mechanical density per unit play time.
  1.0 = sparse, relaxed
  5.0 = dense, relentless

world_building_depth: Richness and depth of the fictional world.
  1.0 = minimal setting
  5.0 = richly developed world with deep lore and internal logic

character_interiority: Depth of psychological portrayal and inner life.
  1.0 = characters are functional; minimal inner life
  5.0 = deep psychological interiority

moral_architecture: Structure of the ethical framework.
  1.0 = clear moral universe, unambiguous good vs. evil
  3.0 = morally complex but the work adjudicates
  5.0 = genuinely relativist or nihilist

diegetic_trust: Degree to which the work withholds explanation and
trusts the player to infer.
  1.0 = over-explains everything
  5.0 = maximally withholding

scope: Scale of the narrative world and stakes.
  1.0 = intimate, contained stakes
  5.0 = epic, civilizational stakes

humor: Degree to which comedy is a primary register of the work.
  1.0 = entirely serious
  3.0 = mixed tone
  5.0 = predominantly comedic

sdt_autonomy: Degree to which the game grants meaningful player agency
and self-determination through branching choices.
  1.0 = fully linear, no meaningful choice
  5.0 = deep branching agency; choices substantially shape outcomes

sdt_competence: Degree to which the game rewards mastery of its
systems, mechanics, and strategic depth.
  1.0 = no systems to master; purely narrative
  5.0 = deeply systemic; high mechanical ceiling

{calibration_block}

Return format (exactly this structure, no other text):
{
  "ugt_cognitive": float,
  "ugt_affective": float,
  "narrative_complexity": float,
  "tonal_register": float,
  "pacing_density": float,
  "world_building_depth": float,
  "character_interiority": float,
  "moral_architecture": float,
  "diegetic_trust": float,
  "scope": float,
  "humor": float,
  "sdt_autonomy": float,
  "sdt_competence": float
}`;

export const DEFAULT_ANCHORS = `Calibration examples (user-confirmed scores — treat these as ground truth):
- Andor (tv): ugt_cognitive=4.2, narrative_complexity=4.5, tonal_register=4.2,
  pacing_serialization=5.0, diegetic_trust=4.0, scope=4.5, moral_architecture=4.0,
  world_building_depth=3.5, character_interiority=3.8, humor=1.2
- Slow Horses (tv): ugt_cognitive=4.1, tonal_register=4.2, pacing_density=2.8,
  character_interiority=4.2, world_building_depth=1.5, scope=1.8,
  narrative_complexity=4.2, humor=1.5
- Piranesi (book): ugt_cognitive=4.6, narrative_complexity=4.8,
  diegetic_trust=4.9, character_interiority=3.5, world_building_depth=3.8,
  scope=2.0, humor=1.8
- Baldur's Gate 3 (game): sdt_autonomy=5.0, sdt_competence=4.8,
  ugt_cognitive=4.0, scope=4.5, world_building_depth=4.8, character_interiority=3.5`;
