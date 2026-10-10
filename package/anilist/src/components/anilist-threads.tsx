import type { AniListEntry, AniListThreadProposal, Destination } from "@tofu/plugins/domain";
import { Badge } from "@tofu/ui/badge";
import { Field, FieldGroup, FieldLabel } from "@tofu/ui/field";
import { Input } from "@tofu/ui/input";
import { OptionSelect } from "@tofu/ui/option-select";

/** Select values cannot be empty, so this sentinel stands for a thread to create. */
const newThread = "new-thread";

export function AniListThreads({
  proposals,
  destinations,
  entries,
  onChange,
  busy,
}: {
  proposals: AniListThreadProposal[];
  destinations: Destination[];
  entries: AniListEntry[];
  onChange: (proposals: AniListThreadProposal[]) => void;
  busy: boolean;
}) {
  const update = (mediaId: number, patch: Partial<Omit<AniListThreadProposal, "mediaId">>) =>
    onChange(
      proposals.map((proposal) =>
        proposal.mediaId === mediaId ? { ...proposal, ...patch } : proposal
      )
    );
  return (
    <section aria-label="Proposed threads" className="automation-preview">
      <div className="automation-row-heading">
        <strong>Proposed threads</strong>
        <Badge variant="outline">{proposals.length} anime(s)</Badge>
      </div>
      <p className="automation-caption">
        Check names and folders before creating tracking. An existing thread with the same folder is
        reused.
      </p>
      {proposals.map((proposal) => (
        <div className="automation-history-item" key={proposal.mediaId}>
          <div className="automation-row-heading">
            <strong>
              {entries.find((entry) => entry.mediaId === proposal.mediaId)?.title ?? proposal.name}
            </strong>
            <a
              href={`https://anilist.co/anime/${proposal.mediaId}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              AniList ↗
            </a>
          </div>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`anilist-thread-${proposal.mediaId}`}>
                Destination thread
              </FieldLabel>
              <OptionSelect
                disabled={busy}
                id={`anilist-thread-${proposal.mediaId}`}
                onValueChange={(value) => {
                  const destination = destinations.find((item) => item.id === value);
                  update(
                    proposal.mediaId,
                    destination
                      ? {
                          destinationId: destination.id,
                          downloadPath: destination.downloadPath,
                          name: destination.name,
                        }
                      : { destinationId: null }
                  );
                }}
                options={[
                  { label: "Create a thread", value: newThread },
                  ...destinations.map((destination) => ({
                    label: `${destination.name} · ${destination.downloadPath}`,
                    value: destination.id,
                  })),
                ]}
                value={proposal.destinationId ?? newThread}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`anilist-thread-name-${proposal.mediaId}`}>
                Thread name
              </FieldLabel>
              <Input
                disabled={busy || proposal.destinationId !== null}
                id={`anilist-thread-name-${proposal.mediaId}`}
                onChange={(event) => update(proposal.mediaId, { name: event.target.value })}
                value={proposal.name}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`anilist-thread-path-${proposal.mediaId}`}>
                Download folder
              </FieldLabel>
              <Input
                disabled={busy || proposal.destinationId !== null}
                id={`anilist-thread-path-${proposal.mediaId}`}
                onChange={(event) => update(proposal.mediaId, { downloadPath: event.target.value })}
                value={proposal.downloadPath}
              />
            </Field>
          </FieldGroup>
        </div>
      ))}
    </section>
  );
}
