import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { AutomationDraft } from "@/api/modules/automation/model";
import type { LiveState } from "@/api/modules/dashboard/projection";
import { PreferenceFields, sourceNames } from "./automation-fields";
import { OptionSelect } from "./option-select";
import { Field, FieldGroup, FieldLabel } from "./ui/field";

const languages = [
  { label: "Any language", value: "any" },
  { label: "VOSTFR", value: "VOSTFR" },
  { label: "VF", value: "VF" },
  { label: "MULTI", value: "MULTI" },
] as const;

export function CompactAutomationFields({
  draft,
  onChange,
  busy,
  prefix,
  destinations,
  children,
  advanced,
}: {
  draft: AutomationDraft;
  onChange: (value: AutomationDraft) => void;
  busy: boolean;
  prefix: string;
  destinations: NonNullable<LiveState["host"]>["destinations"];
  children: ReactNode;
  advanced?: ReactNode;
}) {
  const qualities = [...new Set(["1080p", "720p", "2160p", "480p", ...draft.resolutions])];
  return (
    <>
      <FieldGroup className="notification-automation-fields">
        <Field className="notification-automation-destination">
          <FieldLabel htmlFor={`${prefix}-destination`}>Download to</FieldLabel>
          <OptionSelect
            disabled={busy}
            id={`${prefix}-destination`}
            onValueChange={(value) => onChange({ ...draft, destinationId: value })}
            options={destinations.map((destination) => ({
              label: destination.name,
              value: destination.id,
            }))}
            value={draft.destinationId}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-quality`}>Preferred quality</FieldLabel>
          <OptionSelect
            disabled={busy}
            id={`${prefix}-quality`}
            onValueChange={(value) =>
              onChange({
                ...draft,
                resolutions:
                  value === "any"
                    ? []
                    : [value, ...draft.resolutions.filter((item) => item !== value)],
              })
            }
            options={[
              { label: "Any quality", value: "any" },
              ...qualities.map((value) => ({ label: value, value })),
            ]}
            value={draft.resolutions[0] ?? "any"}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-language`}>Language</FieldLabel>
          <OptionSelect
            disabled={busy}
            id={`${prefix}-language`}
            onValueChange={(value) =>
              onChange({
                ...draft,
                languages:
                  value === "any"
                    ? []
                    : [value, ...draft.languages.filter((item) => item !== value)],
              })
            }
            options={languages}
            value={draft.languages[0] ?? "any"}
          />
        </Field>
      </FieldGroup>
      <p className="notification-automation-defaults">
        <SlidersHorizontalIcon aria-hidden="true" />
        <span>
          {draft.sources.map((source) => sourceNames[source] ?? source).join(" → ")} ·{" "}
          {draft.codecs.join(" → ") || "Any codec"}
        </span>
      </p>
      {children}
      <details className="notification-automation-advanced">
        <summary>
          Advanced preferences <ChevronDownIcon aria-hidden="true" />
        </summary>
        <fieldset className="notification-automation-preferences" disabled={busy}>
          {advanced}
          <PreferenceFields
            idPrefix={`${prefix}-advanced`}
            onChange={onChange}
            value={{ ...draft, deleteReplacedFiles: draft.deleteReplacedFiles === true }}
          />
        </fieldset>
      </details>
    </>
  );
}
