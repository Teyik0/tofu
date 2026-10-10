import type {
  AutomationCriterion,
  AutomationDraft,
  AutomationPreferences,
  SourcePluginId,
} from "@tofu/plugins/domain";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ActionTooltip } from "./action-tooltip";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "./ui/field";
import { Input } from "./ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "./ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export const sourceNames: Record<SourcePluginId, string> = {
  c411: "C411",
  nyaa: "Nyaa",
  tsundere: "Tsundere-Raws",
};
const criterionNames: Record<AutomationCriterion, string> = {
  codec: "Codec",
  language: "Language",
  resolution: "Resolution",
  source: "Source",
};
const languageOptions = [
  { label: "VF", value: "VF" },
  { label: "VOSTFR", value: "VOSTFR" },
  { label: "MULTI", value: "MULTI" },
];
const resolutionOptions = [
  { label: "2160p", value: "2160p" },
  { label: "1080p", value: "1080p" },
  { label: "900p", value: "900p" },
  { label: "720p", value: "720p" },
  { label: "480p", value: "480p" },
];
const codecOptions = [
  { label: "H.265", value: "H.265" },
  { label: "H.264", value: "H.264" },
  { label: "AV1", value: "AV1" },
];

/** One-line summary of formats, e.g. "VOSTFR → VF · 1080p → 720p · Nyaa → Tsundere-Raws". */
export function preferenceSummary(preferences: AutomationPreferences) {
  return [
    preferences.languages.join(" → ") || "Any language",
    preferences.resolutions.join(" → ") || "Any resolution",
    preferences.codecs.join(" → ") || "Any codec",
    preferences.sources.map((id) => sourceNames[id]).join(" → "),
  ];
}

/**
 * Ordered multi-select: the first chip pressed is the most preferred. An empty selection
 * accepts every value, matching the rule engine.
 */
function ChipOrder({
  id,
  label,
  description,
  anyLabel,
  options,
  values,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  anyLabel: string;
  options: { label: string; value: string }[];
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const extra = values.filter((value) => !options.some((option) => option.value === value));
  return (
    <FieldSet className="chip-field" data-value={values.join(",")} id={id}>
      <FieldLegend variant="label">{label}</FieldLegend>
      <div className="chip-order">
        {[...options, ...extra.map((value) => ({ label: value, value }))].map((option) => {
          const rank = values.indexOf(option.value);
          return (
            <button
              aria-pressed={rank >= 0}
              className="chip-order-item"
              key={option.value}
              onClick={() =>
                onChange(
                  rank >= 0
                    ? values.filter((value) => value !== option.value)
                    : [...values, option.value]
                )
              }
              type="button"
            >
              {rank >= 0 ? <b aria-hidden="true">{rank + 1}</b> : null}
              {option.label}
            </button>
          );
        })}
        {values.length ? null : <span className="chip-order-any">{anyLabel}</span>}
      </div>
      <FieldDescription>{description}</FieldDescription>
    </FieldSet>
  );
}

function MoveButtons({
  name,
  first,
  last,
  move,
}: {
  name: string;
  first: boolean;
  last: boolean;
  move: (direction: number) => void;
}) {
  return (
    <div className="order-row-actions">
      <ActionTooltip>
        <Button
          aria-label={`Move ${name} up`}
          disabled={first}
          onClick={() => move(-1)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ArrowUpIcon />
        </Button>
      </ActionTooltip>
      <ActionTooltip>
        <Button
          aria-label={`Move ${name} down`}
          disabled={last}
          onClick={() => move(1)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ArrowDownIcon />
        </Button>
      </ActionTooltip>
    </div>
  );
}

function swap<T>(values: T[], index: number, direction: number) {
  const next = [...values];
  const value = next[index];
  const other = next[index + direction];
  if (value === undefined || other === undefined) {
    return values;
  }
  next[index] = other;
  next[index + direction] = value;
  return next;
}

/** Enabled sources keep their priority order; unchecked ones are listed after them. */
function SourceOrder({
  id,
  values,
  onChange,
}: {
  id: string;
  values: SourcePluginId[];
  onChange: (values: SourcePluginId[]) => void;
}) {
  const unused = (Object.keys(sourceNames) as SourcePluginId[]).filter(
    (source) => !values.includes(source)
  );
  return (
    <FieldSet>
      <FieldLegend variant="label">Sources, in priority order</FieldLegend>
      <div className="order-list">
        {[...values, ...unused].map((source, index) => {
          const used = values.includes(source);
          return (
            <div className="order-row" data-disabled={!used} key={source}>
              <Checkbox
                checked={used}
                disabled={used && values.length === 1}
                id={`${id}-${source}`}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...values, source]
                      : values.filter((item) => item !== source)
                  )
                }
              />
              <span className="order-rank">{used ? index + 1 : "–"}</span>
              <FieldLabel htmlFor={`${id}-${source}`}>{sourceNames[source]}</FieldLabel>
              {used ? (
                <MoveButtons
                  first={index === 0}
                  last={index === values.length - 1}
                  move={(direction) => onChange(swap(values, index, direction))}
                  name={sourceNames[source]}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <FieldDescription>At least one source. Enable sources in Plugins.</FieldDescription>
    </FieldSet>
  );
}

function CriteriaOrder({
  values,
  onChange,
}: {
  values: AutomationCriterion[];
  onChange: (values: AutomationCriterion[]) => void;
}) {
  return (
    <Field>
      <FieldLabel>When several versions match, compare by</FieldLabel>
      <div className="order-list">
        {values.map((value, index) => (
          <div className="order-row" key={value}>
            <span className="order-rank">{index + 1}</span>
            <span>{criterionNames[value]}</span>
            <MoveButtons
              first={index === 0}
              last={index === values.length - 1}
              move={(direction) => onChange(swap(values, index, direction))}
              name={criterionNames[value]}
            />
          </div>
        ))}
      </div>
      <FieldDescription>The first criterion breaks ties before the next one.</FieldDescription>
    </Field>
  );
}

function MinutesField({
  id,
  label,
  description,
  min,
  value,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  min: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          max="1440"
          min={min}
          onChange={(event) => onChange(Number(event.target.value))}
          type="number"
          value={value}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>min</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

function Toggle({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field className="toggle-row" orientation="horizontal">
      <Checkbox checked={checked} id={id} onCheckedChange={(value) => onChange(value === true)} />
      <div>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </div>
    </Field>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fields-section">
      <h4>{title}</h4>
      <div className="fields-section-body">{children}</div>
    </section>
  );
}

/**
 * Formats, sources, timing and behavior. Used by the general preferences, by rules, and by
 * AniList tracking; `idPrefix` keeps field ids unique per form.
 */
export function PreferenceFields<Value extends AutomationPreferences>({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: Value;
  onChange: (value: Value) => void;
}) {
  const set = <K extends keyof AutomationPreferences>(key: K, next: Value[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <>
      <Section title="Quality">
        <ChipOrder
          anyLabel="Any language"
          description="Tap in order of preference. None selected accepts every language. MULTI does not guarantee French subtitles."
          id={`${idPrefix}-language`}
          label="Languages"
          onChange={(next) => set("languages", next)}
          options={languageOptions}
          values={value.languages}
        />
        <ChipOrder
          anyLabel="Any resolution"
          description="Tap in order of preference. None selected accepts every resolution."
          id={`${idPrefix}-resolution`}
          label="Resolutions"
          onChange={(next) => set("resolutions", next)}
          options={resolutionOptions}
          values={value.resolutions}
        />
        <ChipOrder
          anyLabel="Any codec"
          description="Leave empty unless your player needs a specific codec."
          id={`${idPrefix}-codec`}
          label="Codecs"
          onChange={(next) => set("codecs", next)}
          options={codecOptions}
          values={value.codecs}
        />
      </Section>
      <Section title="Sources & ranking">
        <div className="fields-grid">
          <SourceOrder
            id={`${idPrefix}-source`}
            onChange={(next) => set("sources", next)}
            values={value.sources}
          />
          <CriteriaOrder onChange={(next) => set("priority", next)} values={value.priority} />
        </div>
      </Section>
      <Section title="Timing">
        <div className="fields-grid">
          <MinutesField
            description="How often Tofu asks your sources for new releases."
            id={`${idPrefix}-interval`}
            label="Check every"
            min={1}
            onChange={(next) => set("intervalMinutes", next)}
            value={value.intervalMinutes}
          />
          <MinutesField
            description="0 = take the first acceptable version. Otherwise a fallback version waits in the Inbox for this long; the ideal version never waits."
            id={`${idPrefix}-wait`}
            label="Wait for a better version"
            min={0}
            onChange={(next) => set("waitMinutes", next)}
            value={value.waitMinutes}
          />
        </div>
      </Section>
      <Section title="Behavior">
        <div className="fields-grid">
          <Toggle
            checked={value.automatic}
            description="When off, every match waits in the Inbox for your confirmation."
            id={`${idPrefix}-automatic`}
            label="Download automatically"
            onChange={(next) => set("automatic", next)}
          />
          <Toggle
            checked={value.paused}
            description="Torrents are added but do not start until you resume them."
            id={`${idPrefix}-paused`}
            label="Add torrents paused"
            onChange={(next) => set("paused", next)}
          />
          <Toggle
            checked={value.excludePacks}
            description="Skip batches and complete seasons; follow single episodes."
            id={`${idPrefix}-excludePacks`}
            label="Exclude packs"
            onChange={(next) => set("excludePacks", next)}
          />
          <Toggle
            checked={value.deleteReplacedFiles}
            description="When a better version finishes, delete the old files instead of keeping them."
            id={`${idPrefix}-deleteReplacedFiles`}
            label="Delete replaced files"
            onChange={(next) => set("deleteReplacedFiles", next)}
          />
        </div>
      </Section>
    </>
  );
}

export function RuleFields({
  draft,
  onChange,
  identity,
}: {
  draft: AutomationDraft;
  onChange: (draft: AutomationDraft) => void;
  identity?: ReactNode;
}) {
  const set = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) =>
    onChange({ ...draft, [key]: value });
  return (
    <div className="rule-fields">
      <Section title="What to follow">
        {identity ?? (
          <div className="fields-grid">
            <Field>
              <FieldLabel htmlFor="automation-title">Title or release pattern</FieldLabel>
              <Input
                id="automation-title"
                onChange={(event) => set("title", event.target.value)}
                required
                value={draft.title}
              />
              <FieldDescription>
                Check the extracted title; it is used for matching.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="automation-matcher">Matching</FieldLabel>
              <Select
                items={[
                  { label: "Exact title name", value: "exact" },
                  { label: "Release name pattern", value: "pattern" },
                  { label: "Jev + exact fallback", value: "jev" },
                ]}
                onValueChange={(value) => set("matchMode", value as AutomationDraft["matchMode"])}
                value={draft.matchMode}
              >
                <SelectTrigger className="w-full" id="automation-matcher">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    <SelectItem value="exact">Exact title name</SelectItem>
                    <SelectItem value="pattern">Release name pattern</SelectItem>
                    <SelectItem value="jev">Jev + exact fallback</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>Pattern = regular expression on the release name.</FieldDescription>
            </Field>
          </div>
        )}
        <div className="fields-grid">
          <Field>
            <FieldLabel htmlFor="automation-season">Season</FieldLabel>
            <Input
              id="automation-season"
              min="1"
              onChange={(event) =>
                set("season", event.target.value ? Number(event.target.value) : null)
              }
              placeholder="All seasons"
              type="number"
              value={draft.season ?? ""}
            />
          </Field>
          <Toggle
            checked={draft.includeExisting}
            description="Also download releases published before this rule existed."
            id="automation-includeExisting"
            label="Include existing releases"
            onChange={(next) => set("includeExisting", next)}
          />
        </div>
      </Section>
      <PreferenceFields
        idPrefix="automation"
        onChange={(next) => onChange({ ...draft, ...next })}
        value={{ ...draft, deleteReplacedFiles: draft.deleteReplacedFiles === true }}
      />
      <Section title="State">
        <Toggle
          checked={draft.enabled}
          description="A paused rule keeps its settings and history but stops checking."
          id="automation-enabled"
          label="Enable this automation"
          onChange={(next) => set("enabled", next)}
        />
      </Section>
    </div>
  );
}
