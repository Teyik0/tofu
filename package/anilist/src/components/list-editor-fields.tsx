import { Checkbox } from "@tofu/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@tofu/ui/field";
import { Input } from "@tofu/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@tofu/ui/input-group";
import { OptionSelect } from "@tofu/ui/option-select";
import { Separator } from "@tofu/ui/separator";
import { Textarea } from "@tofu/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@tofu/ui/toggle-group";
import { StarIcon } from "lucide-react";
import { AniListDatePicker } from "./date-picker";
import { aniListStatusLabels } from "./status";
import type { AniListListEditorProps, useAniListListEditor } from "./use-list-editor";

export function AniListScoreField({
  model,
  busy,
}: Pick<AniListListEditorProps, "busy"> & { model: ReturnType<typeof useAniListListEditor> }) {
  const { values, edit, commit, change, format, scoreMaximum, scoreIcons } = model;
  return (
    <Field className="anilist-filter">
      <FieldLabel htmlFor="anime-list-score">Score</FieldLabel>
      {format === "POINT_3" || format === "POINT_5" ? (
        <ToggleGroup
          aria-label={`Score: ${values.score ? `${values.score} / ${scoreMaximum}` : "none"}. Select again to clear`}
          className="anime-score-picker"
          disabled={busy}
          id="anime-list-score"
          onValueChange={(selected) => change({ score: Number(selected[0] ?? 0) })}
          spacing={0}
          value={values.score ? [String(values.score)] : []}
        >
          {format === "POINT_3"
            ? scoreIcons.map(({ value, label, sentiment, icon: Icon }) => (
                <ToggleGroupItem
                  aria-label={label}
                  data-sentiment={sentiment}
                  key={value}
                  value={String(value)}
                >
                  <Icon />
                </ToggleGroupItem>
              ))
            : [1, 2, 3, 4, 5].map((score) => (
                <ToggleGroupItem
                  aria-label={`${score} star${score === 1 ? "" : "s"}`}
                  data-filled={score <= (values.score ?? 0)}
                  key={score}
                  value={String(score)}
                >
                  <StarIcon />
                </ToggleGroupItem>
              ))}
        </ToggleGroup>
      ) : (
        <InputGroup>
          <InputGroupInput
            disabled={busy || format === null}
            id="anime-list-score"
            max={scoreMaximum}
            min={0}
            onBlur={commit}
            onChange={(event) => edit({ score: Number(event.target.value) })}
            placeholder="—"
            step={format === "POINT_10_DECIMAL" ? 0.1 : 1}
            title={format ? undefined : "Scoring format unavailable"}
            type="number"
            value={values.score ?? ""}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>/ {format ? scoreMaximum : "—"}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      )}
    </Field>
  );
}

export function AniListListFields({
  model,
  editor,
  media,
  busy,
}: Pick<AniListListEditorProps, "editor" | "media" | "busy"> & {
  model: ReturnType<typeof useAniListListEditor>;
}) {
  const {
    values,
    progressEdited,
    setProgressEdited,
    statusPicked,
    setStatusPicked,
    edit,
    commit,
    change,
    mediaProgress,
  } = model;
  return (
    <FieldGroup className="anime-list-fields">
      <Field className="anilist-filter">
        <FieldLabel htmlFor="anime-list-status">Status</FieldLabel>
        <OptionSelect
          className="anilist-filter-trigger"
          contentClassName="anilist-select-menu"
          disabled={busy}
          id="anime-list-status"
          onValueChange={(status) => {
            const option = aniListStatusLabels.find((item) => item.value === status);
            if (option) {
              setStatusPicked(true);
              change({ status: option.value });
            }
          }}
          options={aniListStatusLabels}
          placeholder="Not in list"
          value={editor.entry || statusPicked ? (values.status ?? "PLANNING") : null}
        />
      </Field>
      <AniListScoreField busy={busy} model={model} />
      <Field className="anilist-filter">
        <FieldLabel htmlFor="anime-list-progress">Episode progress</FieldLabel>
        <InputGroup>
          <InputGroupInput
            disabled={busy}
            id="anime-list-progress"
            max={media.episodes ?? 10_000}
            min={0}
            onBlur={commit}
            onChange={(event) => {
              setProgressEdited(true);
              edit({ progress: Number(event.target.value) });
            }}
            required
            type="number"
            value={(progressEdited ? values.progress : mediaProgress) ?? values.progress ?? 0}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>/ {media.episodes ?? "—"}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      </Field>
      <Field className="anilist-filter">
        <FieldLabel htmlFor="anime-list-start">Start date</FieldLabel>
        <AniListDatePicker
          change={(startedAt) => change({ startedAt })}
          disabled={busy}
          id="anime-list-start"
          label="Start date"
          value={values.startedAt}
        />
      </Field>
      <Field className="anilist-filter">
        <FieldLabel htmlFor="anime-list-finish">Finish date</FieldLabel>
        <AniListDatePicker
          change={(completedAt) => change({ completedAt })}
          disabled={busy}
          id="anime-list-finish"
          label="Finish date"
          value={values.completedAt}
        />
      </Field>
      <Field className="anilist-filter">
        <FieldLabel htmlFor="anime-list-repeat">Total rewatches</FieldLabel>
        <Input
          disabled={busy}
          id="anime-list-repeat"
          max={1000}
          min={0}
          onBlur={commit}
          onChange={(event) => edit({ repeat: Number(event.target.value) })}
          placeholder="—"
          type="number"
          value={values.repeat ?? ""}
        />
      </Field>
      {editor.options.advancedScoringEnabled ? (
        <FieldSet className="anime-list-wide">
          <FieldLegend variant="label">Advanced scores</FieldLegend>
          <FieldGroup className="anime-list-fields">
            {editor.options.advancedScoring.map((name, index) => (
              <Field className="anilist-filter" key={name}>
                <FieldLabel htmlFor={`anime-advanced-score-${index}`}>{name}</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    disabled={busy}
                    id={`anime-advanced-score-${index}`}
                    max={100}
                    min={0}
                    onBlur={commit}
                    onChange={(event) =>
                      edit({
                        advancedScores: (values.advancedScores ?? []).map((score, current) =>
                          current === index ? Number(event.target.value) : score
                        ),
                      })
                    }
                    type="number"
                    value={values.advancedScores?.[index] ?? ""}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText>/ 100</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            ))}
          </FieldGroup>
        </FieldSet>
      ) : null}
      <Field className="anilist-filter anime-list-wide">
        <FieldLabel htmlFor="anime-list-notes">Notes</FieldLabel>
        <Textarea
          disabled={busy}
          id="anime-list-notes"
          maxLength={6000}
          onBlur={commit}
          onChange={(event) => edit({ notes: event.target.value })}
          rows={3}
          value={values.notes ?? ""}
        />
      </Field>
    </FieldGroup>
  );
}

export function AniListListAside({
  model,
  editor,
  busy,
}: Pick<AniListListEditorProps, "editor" | "busy"> & {
  model: ReturnType<typeof useAniListListEditor>;
}) {
  const { values, edit, commit, change } = model;
  const selectedLists = new Set(values.customLists);
  return (
    <FieldGroup className="anime-list-aside">
      <FieldSet className="anilist-filter anime-list-custom">
        <FieldLegend variant="label">Custom lists</FieldLegend>
        {editor.options.customLists.length ? (
          <FieldGroup>
            {editor.options.customLists.map((name, index) => (
              <Field key={name} orientation="horizontal">
                <Checkbox
                  checked={selectedLists.has(name)}
                  disabled={busy}
                  id={`anime-custom-list-${index}`}
                  onCheckedChange={(checked) =>
                    change({
                      customLists:
                        checked === true
                          ? [...(values.customLists ?? []), name]
                          : (values.customLists ?? []).filter((item) => item !== name),
                    })
                  }
                />
                <FieldLabel htmlFor={`anime-custom-list-${index}`}>{name}</FieldLabel>
              </Field>
            ))}
          </FieldGroup>
        ) : (
          <FieldDescription>
            No custom anime lists. Manage them in your AniList settings.
          </FieldDescription>
        )}
      </FieldSet>
      <Separator />
      <FieldSet>
        <FieldLegend className="sr-only" variant="label">
          Visibility
        </FieldLegend>
        <FieldGroup>
          <Field orientation="horizontal">
            <Checkbox
              checked={values.private ?? false}
              disabled={busy}
              id="anime-list-private"
              onCheckedChange={(checked) => change({ private: checked === true })}
            />
            <FieldLabel htmlFor="anime-list-private">Private</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              checked={values.hiddenFromStatusLists ?? false}
              disabled={busy || !editor.options.customLists.length}
              id="anime-list-hidden"
              onCheckedChange={(checked) => change({ hiddenFromStatusLists: checked === true })}
            />
            <FieldLabel htmlFor="anime-list-hidden">Hide from status lists</FieldLabel>
          </Field>
        </FieldGroup>
      </FieldSet>
      <Field className="anilist-filter">
        <FieldLabel htmlFor="anime-list-priority">Priority</FieldLabel>
        <Input
          disabled={busy}
          id="anime-list-priority"
          max={255}
          min={0}
          onBlur={commit}
          onChange={(event) => edit({ priority: Number(event.target.value) })}
          placeholder="—"
          type="number"
          value={values.priority ?? ""}
        />
      </Field>
    </FieldGroup>
  );
}
