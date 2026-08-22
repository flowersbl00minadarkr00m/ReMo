export const MEANINGFUL_CHANGE_CATEGORIES = ["structure", "layout/style-system", "interaction", "navigation", "responsive", "accessibility"] as const;
export type MeaningfulChangeCategory = (typeof MEANINGFUL_CHANGE_CATEGORIES)[number];
export type TypedBoundaryKind = "decision" | "human-intervention" | "verification";
export interface SourceChange { readonly path: string; readonly before: string; readonly after: string }
export interface TypedBoundaryEvent { readonly kind: TypedBoundaryKind; readonly boundaryId: string; readonly occurredAt: string }
export interface NominationInput { readonly changes: readonly SourceChange[]; readonly boundaries: readonly TypedBoundaryEvent[]; readonly uncertainty: boolean }
export interface ChangeClassification { readonly qualifying: boolean; readonly uncertain: boolean; readonly categories: readonly MeaningfulChangeCategory[]; readonly reasonCodes: readonly string[] }
export type NominationResult =
  | { readonly status: "no-candidate"; readonly categories: readonly MeaningfulChangeCategory[]; readonly reasonCodes: readonly string[] }
  | { readonly status: "candidate"; readonly categories: readonly MeaningfulChangeCategory[]; readonly boundaries: readonly TypedBoundaryEvent[]; readonly reasonCodes: readonly string[] };
const SOURCE_PREFIX = "packages/test-fixtures/vs001-ui/src/";
const SUPPORT_PATH = /(?:^|\/)(?:__generated__|generated|support|test-support|fixtures?)(?:\/|$)|\.(?:generated|fixture|stories|story|spec|test)\.tsx$/u;
function stripCommentsAndWhitespace(source: string): string { return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|\s)\/\/.*$/gmu, "$1").replace(/\s+/gu, ""); }
function ordered(categories: Set<MeaningfulChangeCategory>): MeaningfulChangeCategory[] { return MEANINGFUL_CHANGE_CATEGORIES.filter((category) => categories.has(category)); }

export function classifyMeaningfulChange(change: SourceChange): ChangeClassification {
  const path = change.path.replaceAll("\\", "/");
  if (!path.startsWith(SOURCE_PREFIX)) return { qualifying: false, uncertain: false, categories: [], reasonCodes: ["source.excluded"] };
  const relativePath = path.slice(SOURCE_PREFIX.length);
  if (SUPPORT_PATH.test(relativePath) || /(?:^|\/)\w+\.d\.ts$/u.test(relativePath) || /\.map$/u.test(relativePath)) {
    return { qualifying: false, uncertain: false, categories: [], reasonCodes: ["source.generated-or-support"] };
  }
  const extension = path.endsWith(".tsx") ? "tsx" : path.endsWith(".css") ? "css" : undefined;
  if (extension === undefined) return { qualifying: false, uncertain: true, categories: [], reasonCodes: ["source.unsupported-category"] };
  if (stripCommentsAndWhitespace(change.before) === stripCommentsAndWhitespace(change.after)) return { qualifying: false, uncertain: false, categories: [], reasonCodes: ["change.comments-or-whitespace-only"] };
  const categories = new Set<MeaningfulChangeCategory>();
  const changedText = `${change.before}\n${change.after}`;
  if (extension === "tsx") {
    const tags = (source: string) => [...source.matchAll(/<\/?([A-Za-z][\w.-]*)/gu)].map((match) => match[0]).join("|");
    if (tags(change.before) !== tags(change.after)) categories.add("structure");
    if (/\b(?:onClick|onKeyDown|onChange|onSubmit)\b|<(?:button|details|summary)\b/u.test(changedText)) categories.add("interaction");
    if (/\b(?:href|navigate|route|pathname)\b|<(?:a|Link)\b/u.test(changedText)) categories.add("navigation");
    if (/\b(?:aria-[\w-]+|role|tabIndex|htmlFor)\b|<(?:label|header|nav|main)\b/u.test(changedText)) categories.add("accessibility");
  } else {
    categories.add("layout/style-system");
    if (/@(?:media|container)\b|\b(?:clamp|min|max)\(/u.test(changedText)) categories.add("responsive");
  }
  const values = ordered(categories);
  return { qualifying: values.length > 0, uncertain: values.length === 0, categories: values, reasonCodes: values.length > 0 ? [] : ["change.unclassified"] };
}

export function nominateMeaningfulChange(input: NominationInput): NominationResult {
  const classifications = input.changes.map(classifyMeaningfulChange);
  const categories = ordered(new Set(classifications.flatMap((item) => item.categories)));
  const uniqueBoundaries = new Map<string, TypedBoundaryEvent>();
  for (const boundary of input.boundaries) uniqueBoundaries.set(`${boundary.kind}:${boundary.boundaryId}`, boundary);
  const boundaries = [...uniqueBoundaries.values()].sort((a, b) => `${a.kind}:${a.boundaryId}`.localeCompare(`${b.kind}:${b.boundaryId}`, "en-US"));
  const reasons: string[] = [];
  if (categories.length === 0) reasons.push("nomination.no-meaningful-change");
  if (boundaries.length === 0) reasons.push("nomination.no-typed-boundary");
  if (input.uncertainty || classifications.some((item) => item.uncertain)) reasons.push("nomination.uncertain-input");
  if (reasons.length > 0) return { status: "no-candidate", categories, reasonCodes: reasons };
  return { status: "candidate", categories, boundaries, reasonCodes: ["nomination.meaningful-change-with-boundary"] };
}
