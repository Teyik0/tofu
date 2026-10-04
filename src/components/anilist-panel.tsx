import { useQuery } from "@teyik0/furin/client";
import { CheckIcon, ExternalLinkIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api } from "../client";
import type {
  AniListState,
  AniListStatus,
  AniListSubscription,
  AniListThreadProposal,
  AutomationDraft,
  AutomationRule,
  Destination,
  PluginState,
} from "../types";
import { ActionTooltip } from "./action-tooltip";
import { AniListThreads } from "./anilist-threads";
import { request } from "./api";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button, buttonVariants } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Textarea } from "./ui/textarea";

type Action = (task: () => Promise<void>) => void;
function AniListConnection({
  state,
  action,
  reload,
  busy,
}: {
  state: AniListState;
  action: Action;
  reload: () => Promise<void>;
  busy: boolean;
}) {
  const [clientId, setClientId] = useState(state.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(state.redirectUri);
  const [userName, setUserName] = useState(state.userName);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const configure = () =>
    request("/anilist", "PUT", {
      clientId,
      redirectUri,
      userName,
      ...(clientSecret ? { clientSecret } : {}),
    });
  return (
    <section className="automation-editor">
      <div className="automation-row-heading">
        <strong>Votre compte AniList</strong>
        <Badge variant="outline">{state.connectedUser ?? "Non vérifié"}</Badge>
      </div>
      <FieldGroup>
        <div className="automation-field-grid">
          <Field>
            <FieldLabel htmlFor="anilist-client-id">ID du client OAuth</FieldLabel>
            <Input
              id="anilist-client-id"
              onChange={(event) => setClientId(event.target.value)}
              placeholder="9037"
              value={clientId}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="anilist-client-secret">Secret du client OAuth</FieldLabel>
            <Input
              autoComplete="off"
              id="anilist-client-secret"
              onChange={(event) => setClientSecret(event.target.value)}
              placeholder={
                state.hasClientSecret
                  ? "Secret enregistré · saisir pour remplacer"
                  : "Secret du client"
              }
              type="password"
              value={clientSecret}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="anilist-redirect">URL de retour OAuth</FieldLabel>
          <Input
            id="anilist-redirect"
            onChange={(event) => setRedirectUri(event.target.value)}
            value={redirectUri}
          />
          <FieldDescription>
            Doit correspondre exactement à celle du client dans AniList → Settings → Developer. Tofu
            ouvre ce port local pendant la connexion.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="anilist-username">Ou un nom de compte public</FieldLabel>
          <Input
            id="anilist-username"
            onChange={(event) => setUserName(event.target.value)}
            placeholder="Votre pseudo AniList"
            value={userName}
          />
          <FieldDescription>
            Pour une liste publique, le nom suffit. Pour une liste privée, connectez le compte ou
            ajoutez un token d’accès dans Plugins → AniList.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <div className="automation-form-actions">
        <Button
          disabled={busy}
          onClick={() =>
            action(async () => {
              await configure();
              setClientSecret("");
              await reload();
            })
          }
          variant="outline"
        >
          Enregistrer la connexion
        </Button>
        <Button
          disabled={busy || !clientId || !(clientSecret || state.hasClientSecret)}
          onClick={() =>
            action(async () => {
              await configure();
              const { url } = await request<{ url: string }>("/anilist/connect", "POST", {});
              const result = await request<{ url: string; opened: boolean }>(
                "/anilist/open",
                "POST",
                { url }
              );
              if (!result.opened) {
                setAuthorizationUrl(result.url);
              }
              setClientSecret("");
              await reload();
            })
          }
        >
          <ExternalLinkIcon data-icon="inline-start" />
          Connecter AniList
        </Button>
        {authorizationUrl !== null && (
          <a
            className={buttonVariants({ variant: "outline" })}
            href={authorizationUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Autoriser dans le navigateur
          </a>
        )}
      </div>
      <p className="automation-caption">
        Après autorisation dans le navigateur, revenez ici et cliquez sur Actualiser.
      </p>
    </section>
  );
}

export function AniListPanel({
  target,
  destinationField,
  busy,
  action,
  reloadPlugins,
  renderTemplate,
  plugin,
  destinations,
  automations,
}: {
  target: string;
  destinationField: ReactNode;
  busy: boolean;
  action: Action;
  reloadPlugins: () => Promise<void>;
  renderTemplate: (draft: AutomationDraft, onChange: (draft: AutomationDraft) => void) => ReactNode;
  plugin: PluginState | undefined;
  destinations: Destination[];
  automations: AutomationRule[];
}) {
  const { data: live } = useQuery(api.api.anilist.get);
  const [saved, setSaved] = useState<AniListState | null>(null);
  const state = saved ?? (live && "subscriptions" in live ? live : null);
  const [query, setQuery] = useState("Sur Nyaa, en VOSTFR, préfère 1080p puis 720p.");
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const [statuses, setStatuses] = useState<AniListStatus[]>(["CURRENT", "PLANNING"]);
  const [mode, setMode] = useState<"per-anime" | "shared">("per-anime");
  const [basePath, setBasePath] = useState(
    () => destinations.find((destination) => destination.id === target)?.downloadPath ?? ""
  );
  const [proposals, setProposals] = useState<AniListThreadProposal[] | null>(null);
  const reload = async () => {
    setSaved(await request<AniListState>("/anilist", "GET", undefined));
    await reloadPlugins();
  };
  if (!state) {
    return <p>Chargement de la connexion AniList…</p>;
  }
  const selectedCount = state.entries.filter(
    (entry) =>
      statuses.includes(entry.status) &&
      state.selections.some((selection) => selection.mediaId === entry.mediaId && selection.enabled)
  ).length;
  return (
    <>
      <div className="automation-section-heading">
        <span className="automation-caption">ANILIST · WATCHING & PLAN TO WATCH</span>
        <Button disabled={busy} onClick={() => action(reload)} size="sm" variant="ghost">
          <RefreshCwIcon data-icon="inline-start" />
          Actualiser
        </Button>
      </div>
      <AniListConnection action={action} busy={busy} reload={reload} state={state} />
      {!plugin?.enabled && (
        <Alert>
          <AlertDescription>
            Activez le plugin AniList pour lire vos listes et synchroniser les suivis. La connexion
            OAuth l’active après autorisation.
          </AlertDescription>
        </Alert>
      )}
      <div className="automation-form-actions">
        <Button
          disabled={busy || !plugin?.enabled}
          onClick={() =>
            action(async () => {
              setSaved(await request<AniListState>("/anilist/list", "POST", {}));
              setProposals(null);
            })
          }
          variant="outline"
        >
          Charger Watching et Plan to Watch
        </Button>
      </div>
      {state.entries.length > 0 && (
        <div className="automation-preview">
          <div className="automation-row-heading">
            <strong>Choisissez les animés à télécharger</strong>
            <Badge variant="outline">
              {state.selections.filter((selection) => selection.enabled).length} validé(s)
            </Badge>
          </div>
          <p className="automation-caption">
            Vos choix restent dans Tofu. Votre liste AniList reste inchangée. Chaque nouveau titre
            attend votre validation.
          </p>
          {state.entries.map((entry) => (
            <div className="automation-history-item" key={entry.mediaId}>
              <Field orientation="horizontal">
                <Checkbox
                  checked={state.selections.some(
                    (selection) => selection.mediaId === entry.mediaId && selection.enabled
                  )}
                  disabled={busy}
                  id={`anilist-title-${entry.mediaId}`}
                  onCheckedChange={(checked) =>
                    action(async () => {
                      setProposals(null);
                      setSaved(
                        await request<AniListState>(`/anilist/entries/${entry.mediaId}`, "PUT", {
                          enabled: checked === true,
                        })
                      );
                      await reloadPlugins();
                    })
                  }
                />
                <FieldLabel htmlFor={`anilist-title-${entry.mediaId}`}>{entry.title}</FieldLabel>
              </Field>
              <div className="feed-release-meta">
                <Badge variant="outline">
                  {entry.status === "CURRENT" ? "Watching" : "Plan to Watch"}
                </Badge>
                <span>{entry.progress} épisode(s) regardé(s)</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <section className="automation-editor">
        <strong>Suivre automatiquement ces listes</strong>
        {destinationField}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="anilist-organization">Organisation des threads</FieldLabel>
            <NativeSelect
              disabled={busy}
              id="anilist-organization"
              onChange={(event) =>
                setMode(event.target.value === "shared" ? "shared" : "per-anime")
              }
              value={mode}
            >
              <NativeSelectOption value="per-anime">Un thread par anime</NativeSelectOption>
              <NativeSelectOption value="shared">
                Tous les animes dans le thread choisi
              </NativeSelectOption>
            </NativeSelect>
            <FieldDescription>
              Chaque anime validé possède une automation liée à AniList.
            </FieldDescription>
          </Field>
          {mode === "per-anime" && (
            <Field>
              <FieldLabel htmlFor="anilist-base-path">Dossier racine</FieldLabel>
              <Input
                disabled={busy}
                id="anilist-base-path"
                onChange={(event) => {
                  setBasePath(event.target.value);
                  setProposals(null);
                }}
                placeholder="/video"
                value={basePath}
              />
              <FieldDescription>
                Exemple : /video → One Piece dans /video/one-piece. Vous pourrez modifier chaque
                proposition.
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>
        <Field>
          <FieldLabel htmlFor="anilist-preferences">
            Vos préférences pour les titres de la liste
          </FieldLabel>
          <Textarea
            id="anilist-preferences"
            onChange={(event) => {
              setQuery(event.target.value);
              setDraft(null);
            }}
            rows={2}
            value={query}
          />
          <FieldDescription>
            Les noms et leurs alias viennent d’AniList. Les épisodes déjà regardés sont exclus. Le
            suivi crée une règle par titre validé dans le thread choisi pour cet anime.
          </FieldDescription>
        </Field>
        <div className="automation-checks">
          {(["CURRENT", "PLANNING"] as const).map((status) => (
            <Field key={status} orientation="horizontal">
              <Checkbox
                checked={statuses.includes(status)}
                id={`anilist-${status}`}
                onCheckedChange={(checked) => {
                  setProposals(null);
                  setStatuses(
                    checked === true
                      ? [...statuses, status]
                      : statuses.filter((value) => value !== status)
                  );
                }}
              />
              <FieldLabel htmlFor={`anilist-${status}`}>
                {status === "CURRENT" ? "Watching" : "Plan to Watch"}
              </FieldLabel>
            </Field>
          ))}
        </div>
        <div className="automation-form-actions">
          <Button
            disabled={
              busy ||
              !query.trim() ||
              !statuses.length ||
              (mode === "per-anime" && !basePath.trim())
            }
            onClick={() =>
              action(async () => {
                const [value, threads] = await Promise.all([
                  request<AutomationDraft>("/automations/interpret", "POST", {
                    destinationId: target,
                    query,
                  }),
                  mode === "per-anime"
                    ? request<AniListThreadProposal[]>("/anilist/threads/preview", "POST", {
                        basePath,
                        statuses,
                      })
                    : Promise.resolve(null),
                ]);
                setProposals(threads);
                setDraft({
                  ...value,
                  includeExisting: true,
                  title: "Titres de mes listes AniList",
                });
              })
            }
            variant="outline"
          >
            Préparer le suivi
          </Button>
        </div>
        {draft !== null && (
          <>
            {mode === "per-anime" && proposals !== null && (
              <AniListThreads
                busy={busy}
                destinations={destinations}
                entries={state.entries}
                onChange={setProposals}
                proposals={proposals}
              />
            )}
            {renderTemplate({ ...draft, destinationId: target }, setDraft)}
            <FieldDescription>
              Le champ Nom est remplacé par chaque titre AniList. Un titre retiré des listes suivies
              est mis en pause ; les téléchargements existants sont conservés.
            </FieldDescription>
            <div className="automation-form-actions">
              <Button
                disabled={
                  busy ||
                  !statuses.length ||
                  !selectedCount ||
                  !plugin?.enabled ||
                  !draft.sources.length ||
                  (mode === "per-anime" &&
                    (proposals === null ||
                      proposals.length !== selectedCount ||
                      proposals.some(
                        (proposal) => !(proposal.name.trim() && proposal.downloadPath.trim())
                      )))
                }
                onClick={() =>
                  action(async () => {
                    const subscription = await request<AniListSubscription>(
                      "/anilist/subscriptions",
                      "POST",
                      {
                        enabled: true,
                        intervalMinutes: Math.max(5, draft.intervalMinutes),
                        organization:
                          mode === "per-anime"
                            ? { basePath, mode, overrides: proposals ?? [] }
                            : { mode },
                        statuses,
                        template: { ...draft, destinationId: target },
                      }
                    );
                    await request(`/anilist/subscriptions/${subscription.id}/sync`, "POST", {});
                    setDraft(null);
                    await reload();
                  })
                }
              >
                <CheckIcon data-icon="inline-start" />
                Créer le suivi AniList
              </Button>
            </div>
          </>
        )}
      </section>
      {state.subscriptions
        .filter((subscription) => subscription.template.destinationId === target)
        .map((subscription) => (
          <article className="automation-rule" key={subscription.id}>
            <div className="automation-row-heading">
              <strong>
                {subscription.statuses
                  .map((status) => (status === "CURRENT" ? "Watching" : "Plan to Watch"))
                  .join(" + ")}
              </strong>
              <Badge variant="outline">
                {subscription.enabled
                  ? `${subscription.bindings.filter((binding) => binding.active).length} titres suivis`
                  : "En pause"}
              </Badge>
            </div>
            <p>{subscription.template.query}</p>
            <p className="automation-caption">
              {subscription.organization?.mode === "per-anime"
                ? `Un thread par anime · ${subscription.organization.basePath}`
                : "Tous les animes dans ce thread"}
            </p>
            {subscription.bindings.map((binding) => {
              const rule = automations.find((item) => item.id === binding.ruleId);
              const destination = destinations.find((item) => item.id === rule?.destinationId);
              return (
                <div className="feed-release-meta" key={binding.mediaId}>
                  <a
                    href={`https://anilist.co/anime/${binding.mediaId}`}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {rule?.title ?? `Anime ${binding.mediaId}`} ↗
                  </a>
                  <span>
                    → {destination?.name ?? "—"} · {destination?.downloadPath ?? "—"}
                  </span>
                </div>
              );
            })}
            <span className="automation-caption">
              Synchronisation toutes les {subscription.intervalMinutes} min ·{" "}
              {subscription.lastSyncAt === null
                ? "Jamais synchronisé"
                : new Date(subscription.lastSyncAt).toLocaleString("fr-FR")}
            </span>
            {subscription.error !== null && (
              <Alert>
                <AlertDescription>{subscription.error}</AlertDescription>
              </Alert>
            )}
            <div className="automation-rule-actions">
              <Button
                disabled={busy || !plugin?.enabled || !subscription.enabled}
                onClick={() =>
                  action(async () => {
                    await request(`/anilist/subscriptions/${subscription.id}/sync`, "POST", {});
                    await reload();
                  })
                }
                size="sm"
                variant="outline"
              >
                Synchroniser
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await request(`/anilist/subscriptions/${subscription.id}`, "PUT", {
                      enabled: !subscription.enabled,
                    });
                    await reload();
                  })
                }
                size="sm"
                variant="ghost"
              >
                {subscription.enabled ? "Mettre en pause" : "Activer"}
              </Button>
              <ActionTooltip>
                <Button
                  aria-label="Supprimer le suivi AniList"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await request(
                        `/anilist/subscriptions/${subscription.id}`,
                        "DELETE",
                        undefined
                      );
                      await reload();
                    })
                  }
                  size="icon-sm"
                  variant="ghost"
                >
                  <TrashIcon />
                </Button>
              </ActionTooltip>
            </div>
          </article>
        ))}
    </>
  );
}
