import { useQuery } from "@teyik0/furin/client";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TrashIcon,
  ZapIcon,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../client";
import type {
  AutomationCriterion,
  AutomationDecision,
  AutomationDraft,
  AutomationRule,
  AutomationState,
  DiscoveryResult,
  FeedRelease,
  PluginState,
  SourcePluginId,
} from "../types";
import { ActionTooltip } from "./action-tooltip";
import { AniListPanel } from "./anilist-panel";
import { request } from "./api";
import { useDashboard } from "./app-shell";
import { bytes } from "./format";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "./ui/field";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

const sourceNames: Record<SourcePluginId, string> = {
  c411: "C411",
  nyaa: "Nyaa",
  tsundere: "Tsundere-Raws",
};
const criterionNames: Record<AutomationCriterion, string> = {
  codec: "Codec",
  language: "Langue",
  resolution: "Résolution",
  source: "Flux",
};
const ruleStatuses: Record<AutomationRule["status"], string> = {
  active: "Active",
  error: "À vérifier",
  paused: "En pause",
  running: "Vérification…",
  "source-disabled": "Plugin désactivé",
};
const decisionStatuses: Record<AutomationDecision["status"], string> = {
  added: "Ajouté",
  adding: "Ajout en cours",
  error: "En erreur",
  ignored: "Ignoré",
  review: "À confirmer",
  waiting: "En attente",
};
type Action = (task: () => Promise<void>) => void;
type Preview = DiscoveryResult & {
  candidates: {
    release: FeedRelease;
    reason: string | null;
    probability: number | null;
    uncertain: boolean;
  }[];
};
const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function QuietEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ZapIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function PluginCard({
  plugin,
  busy,
  action,
  reload,
}: {
  plugin: PluginState;
  busy: boolean;
  action: Action;
  reload: () => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [limit, setLimit] = useState(String(plugin.dailyLimit));
  const save = (enabled: boolean) =>
    action(async () => {
      await request(`/plugins/${plugin.id}`, "PUT", {
        enabled,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        dailyLimit: Number(limit),
      });
      setKey("");
      await reload();
    });
  const keyed = plugin.id === "jev" || plugin.id === "c411" || plugin.id === "anilist";
  return (
    <article className="plugin-card">
      <div className="automation-row-heading">
        <div className="flex items-center gap-2">
          <PlugIcon aria-hidden="true" />
          <strong>{plugin.name}</strong>
          <Badge variant={plugin.enabled ? "secondary" : "outline"}>
            {plugin.enabled ? "Activé" : "Désactivé"}
          </Badge>
        </div>
        <Checkbox
          aria-label={`Activer ${plugin.name}`}
          checked={plugin.enabled}
          disabled={busy}
          id={`plugin-${plugin.id}`}
          onCheckedChange={(value) => save(value === true)}
        />
      </div>
      <p>{plugin.description}</p>
      {keyed === true && (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`key-${plugin.id}`}>
              {plugin.id === "anilist"
                ? "Token d’accès AniList"
                : `Clé API ${plugin.id === "jev" ? "TypeSafe" : "C411"}`}
            </FieldLabel>
            <Input
              autoComplete="off"
              id={`key-${plugin.id}`}
              onChange={(event) => setKey(event.target.value)}
              placeholder={
                plugin.hasApiKey
                  ? "Clé enregistrée · saisir pour remplacer"
                  : "Votre clé personnelle"
              }
              type="password"
              value={key}
            />
            <FieldDescription>
              {plugin.id === "anilist"
                ? "Token OAuth personnel, différent du secret du client. La connexion est disponible dans l’onglet AniList."
                : plugin.id === "jev"
                  ? "Sans clé : nom exact ou pattern. Les titres et métadonnées évalués sont envoyés à TypeSafe."
                  : "Disponible dans C411 → Intégrations API. La clé reste côté serveur."}
            </FieldDescription>
          </Field>
          {plugin.id === "jev" && (
            <Field>
              <FieldLabel htmlFor="jev-daily-limit">Plafond d’appels par jour</FieldLabel>
              <Input
                id="jev-daily-limit"
                max="100000"
                min="1"
                onChange={(event) => setLimit(event.target.value)}
                type="number"
                value={limit}
              />
              <FieldDescription>
                {plugin.callsToday} appel(s) aujourd’hui · les évaluations en cache ne sont pas
                facturées à nouveau.
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>
      )}
      {plugin.error !== null && (
        <Alert>
          <AlertDescription>{plugin.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {keyed === true && (
          <Button disabled={busy} onClick={() => save(plugin.enabled)} size="sm" variant="outline">
            Enregistrer
          </Button>
        )}
        <Button
          disabled={busy || !plugin.enabled}
          onClick={() =>
            action(async () => {
              await request(`/plugins/${plugin.id}/test`, "POST", {});
              await reload();
            })
          }
          size="sm"
          variant="ghost"
        >
          Tester la connexion
        </Button>
        {plugin.checkedAt !== null && (
          <span className="automation-caption">
            Vérifié à {new Date(plugin.checkedAt).toLocaleTimeString("fr-FR")}
          </span>
        )}
      </div>
    </article>
  );
}

function OrderEditor<T extends string>({
  values,
  names,
  onChange,
  label,
}: {
  values: T[];
  names: Record<T, string>;
  onChange: (values: T[]) => void;
  label: string;
}) {
  const move = (index: number, direction: number) => {
    const next = [...values];
    const value = next[index];
    const other = next[index + direction];
    if (value === undefined || other === undefined) {
      return;
    }
    next[index] = other;
    next[index + direction] = value;
    onChange(next);
  };
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="priority-list">
        {values.map((value, index) => (
          <div className="priority-item" key={value}>
            <span className="priority-number">{index + 1}</span>
            <span>{names[value]}</span>
            <div className="ml-auto flex gap-1">
              <ActionTooltip>
                <Button
                  aria-label={`Monter ${names[value]}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <ArrowUpIcon />
                </Button>
              </ActionTooltip>
              <ActionTooltip>
                <Button
                  aria-label={`Descendre ${names[value]}`}
                  disabled={index === values.length - 1}
                  onClick={() => move(index, 1)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <ArrowDownIcon />
                </Button>
              </ActionTooltip>
            </div>
          </div>
        ))}
      </div>
    </Field>
  );
}

function RuleFields({
  draft,
  onChange,
}: {
  draft: AutomationDraft;
  onChange: (draft: AutomationDraft) => void;
}) {
  const set = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) =>
    onChange({ ...draft, [key]: value });
  return (
    <FieldGroup>
      <div className="automation-field-grid">
        <Field>
          <FieldLabel htmlFor="automation-title">Nom exact ou pattern de secours</FieldLabel>
          <Input
            id="automation-title"
            onChange={(event) => set("title", event.target.value)}
            required
            value={draft.title}
          />
          <FieldDescription>
            Vérifiez le titre extrait. Il sert aussi au matching sans Jev.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="automation-matcher">Matching</FieldLabel>
          <Select
            items={[
              { label: "Nom exact du titre", value: "exact" },
              { label: "Pattern sur le nom de sortie", value: "pattern" },
              { label: "Jev + secours exact", value: "jev" },
            ]}
            onValueChange={(value) => set("matchMode", value as AutomationDraft["matchMode"])}
            value={draft.matchMode}
          >
            <SelectTrigger className="w-full" id="automation-matcher">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectItem value="exact">Nom exact du titre</SelectItem>
                <SelectItem value="pattern">Pattern sur le nom de sortie</SelectItem>
                <SelectItem value="jev">Jev + secours exact</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="automation-field-grid">
        <Field>
          <FieldLabel htmlFor="automation-language">Langues acceptées, par priorité</FieldLabel>
          <Input
            id="automation-language"
            onChange={(event) =>
              set(
                "languages",
                list(event.target.value).map((value) => value.toUpperCase())
              )
            }
            placeholder="VF, MULTI ou VOSTFR"
            value={draft.languages.join(", ")}
          />
          <FieldDescription>
            Vide = toutes. MULTI ne prouve pas la présence de sous-titres français.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="automation-resolution">Résolutions, par priorité</FieldLabel>
          <Input
            id="automation-resolution"
            onChange={(event) =>
              set(
                "resolutions",
                list(event.target.value).map((value) => value.toLowerCase())
              )
            }
            placeholder="1080p, 720p"
            value={draft.resolutions.join(", ")}
          />
          <FieldDescription>
            Une seule valeur = exigence. Plusieurs = replis autorisés.
          </FieldDescription>
        </Field>
      </div>
      <div className="automation-field-grid">
        <Field>
          <FieldLabel htmlFor="automation-codec">Codecs acceptés, par priorité</FieldLabel>
          <Input
            id="automation-codec"
            onChange={(event) => set("codecs", list(event.target.value))}
            placeholder="H.265, H.264, AV1"
            value={draft.codecs.join(", ")}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="automation-season">Saison</FieldLabel>
          <Input
            id="automation-season"
            min="1"
            onChange={(event) =>
              set("season", event.target.value ? Number(event.target.value) : null)
            }
            placeholder="Toutes"
            type="number"
            value={draft.season ?? ""}
          />
        </Field>
      </div>
      <div className="automation-field-grid">
        <OrderEditor
          label="Priorité des flux"
          names={sourceNames}
          onChange={(value) => set("sources", value)}
          values={draft.sources}
        />
        <OrderEditor
          label="Ordre des critères"
          names={criterionNames}
          onChange={(value) => set("priority", value)}
          values={draft.priority}
        />
      </div>
      <Field>
        <FieldLabel>Sources utilisées</FieldLabel>
        <div className="flex flex-wrap gap-4">
          {(Object.keys(sourceNames) as SourcePluginId[]).map((id) => (
            <Field key={id} orientation="horizontal">
              <Checkbox
                checked={draft.sources.includes(id)}
                id={`source-${id}`}
                onCheckedChange={(value) =>
                  set(
                    "sources",
                    value === true
                      ? [...draft.sources, id]
                      : draft.sources.filter((source) => source !== id)
                  )
                }
              />
              <FieldLabel htmlFor={`source-${id}`}>{sourceNames[id]}</FieldLabel>
            </Field>
          ))}
        </div>
      </Field>
      <div className="automation-field-grid">
        <Field>
          <FieldLabel htmlFor="automation-interval">Vérifier toutes les (minutes)</FieldLabel>
          <Input
            id="automation-interval"
            max="1440"
            min="1"
            onChange={(event) => set("intervalMinutes", Number(event.target.value))}
            type="number"
            value={draft.intervalMinutes}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="automation-wait">
            Attendre une meilleure version (minutes)
          </FieldLabel>
          <Input
            id="automation-wait"
            max="1440"
            min="0"
            onChange={(event) => set("waitMinutes", Number(event.target.value))}
            type="number"
            value={draft.waitMinutes}
          />
          <FieldDescription>
            0 = immédiat. La combinaison idéale démarre sans attendre. Une version de repli reste
            surveillée et sera remplacée par une meilleure selon vos priorités.
          </FieldDescription>
        </Field>
      </div>
      <div className="automation-checks">
        {(
          [
            { key: "automatic", label: "Télécharger automatiquement" },
            { key: "includeExisting", label: "Inclure les sorties déjà disponibles" },
            { key: "excludePacks", label: "Exclure les packs et intégrales" },
            { key: "paused", label: "Ajouter les torrents en pause" },
            {
              key: "deleteReplacedFiles",
              label: "Supprimer les anciens fichiers après remplacement",
            },
            { key: "enabled", label: "Activer cette automatisation" },
          ] as const
        ).map((option) => (
          <Field key={option.key} orientation="horizontal">
            <Checkbox
              checked={draft[option.key] === true}
              id={`automation-${option.key}`}
              onCheckedChange={(value) => set(option.key, value === true)}
            />
            <FieldLabel htmlFor={`automation-${option.key}`}>{option.label}</FieldLabel>
          </Field>
        ))}
      </div>
      <FieldDescription>
        L’ancienne version est retirée une fois la nouvelle entièrement téléchargée. Ses fichiers
        sont conservés sauf si vous cochez leur suppression. Une correspondance idéale n’est plus
        réévaluée ; les nouveaux épisodes restent surveillés.
      </FieldDescription>
    </FieldGroup>
  );
}

function ReleaseRow({ release, children }: { release: FeedRelease; children?: React.ReactNode }) {
  return (
    <div className="feed-release">
      <div className="min-w-0">
        <strong title={release.title}>{release.title}</strong>
        <div className="feed-release-meta">
          <Badge variant="outline">{sourceNames[release.sourceId]}</Badge>
          <span>{release.resolution ?? "—"}</span>
          <span>{release.language ?? "—"}</span>
          <span>{bytes(release.size)}</span>
          <span>{release.seeders === null ? "—" : release.seeders} sources</span>
        </div>
      </div>
      {children}
    </div>
  );
}

export function AutomationCenter({
  initialTab,
  destinationId,
  close,
}: {
  initialTab: "plugins" | "automations";
  destinationId: string;
  close: () => void;
}) {
  const { data: dashboard, refresh } = useDashboard();
  const { data: live, error: loadingError } = useQuery(api.api.automation.get);
  const [saved, setSaved] = useState<AutomationState | null>(null);
  const state: AutomationState | null =
    live && "plugins" in live && (!saved || live.updatedAt > saved.updatedAt) ? live : saved;
  const [tab, setTab] = useState(initialTab as string);
  const [target, setTarget] = useState(destinationId);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [search, setSearch] = useState("");
  const [excludedSources, setExcludedSources] = useState<SourcePluginId[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    setSaved(await request<AutomationState>("/automation", "GET", undefined));
  };
  const action: Action = (task) => {
    setBusy(true);
    setError(null);
    void task()
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Une erreur est survenue")
      )
      .finally(() => setBusy(false));
  };
  const destination = dashboard.destinations.find((item) => item.id === target);
  const activeSources =
    state?.plugins.filter(
      (plugin): plugin is PluginState & { id: SourcePluginId } =>
        plugin.enabled && (plugin.id === "nyaa" || plugin.id === "tsundere" || plugin.id === "c411")
    ) ?? [];
  const selectedSources = activeSources.filter((plugin) => !excludedSources.includes(plugin.id));
  const naturalSearch =
    state?.plugins.some((plugin) => plugin.id === "jev" && plugin.enabled && plugin.hasApiKey) ===
    true;
  const rules = state?.automations.filter((rule) => rule.destinationId === target) ?? [];
  const decisions =
    state?.decisions.filter((decision) =>
      rules.some((rule) => rule.id === decision.automationId)
    ) ?? [];
  const reset = () => {
    setDraft(null);
    setEditId(null);
    setQuery("");
    setPreview(null);
  };
  const interpret = (event: FormEvent) => {
    event.preventDefault();
    action(async () => {
      setDraft(
        await request<AutomationDraft>("/automations/interpret", "POST", {
          destinationId: target,
          query,
        })
      );
      setPreview(null);
    });
  };
  const save = () =>
    action(async () => {
      if (!draft) {
        return;
      }
      const rule = await request<AutomationRule>(
        editId ? `/automations/${editId}` : "/automations",
        editId ? "PUT" : "POST",
        { ...draft, destinationId: target }
      );
      reset();
      if (rule.enabled) {
        await request(`/automations/${rule.id}/run`, "POST", {});
      }
      await reload();
      await refresh();
    });
  const edit = (rule: AutomationRule) => {
    const fields: AutomationDraft = {
      afterEpisode: rule.afterEpisode,
      aliases: rule.aliases,
      automatic: rule.automatic,
      codecs: rule.codecs,
      destinationId: rule.destinationId,
      enabled: rule.enabled,
      excludePacks: rule.excludePacks,
      includeExisting: rule.includeExisting,
      intervalMinutes: rule.intervalMinutes,
      languages: rule.languages,
      matchMode: rule.matchMode,
      paused: rule.paused,
      priority: rule.priority,
      query: rule.query,
      resolutions: rule.resolutions,
      season: rule.season,
      sources: rule.sources,
      title: rule.title,
      waitMinutes: rule.waitMinutes,
    };
    setEditId(rule.id);
    setQuery(rule.query);
    setDraft(fields);
    setPreview(null);
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
    >
      <DialogContent className="automation-dialog">
        <DialogHeader>
          <DialogTitle>Sources & automatisations</DialogTitle>
          <DialogDescription>
            Vos flux, vos priorités. Chaque règle télécharge dans le dossier de son thread.
          </DialogDescription>
        </DialogHeader>
        <Tabs onValueChange={setTab} value={tab}>
          <TabsList variant="line">
            <TabsTrigger value="plugins">
              <PlugIcon />
              Plugins
            </TabsTrigger>
            <TabsTrigger value="discover">
              <SearchIcon />
              Découvrir
            </TabsTrigger>
            <TabsTrigger value="automations">
              <ZapIcon />
              Automatisations
            </TabsTrigger>
            <TabsTrigger value="history">Historique</TabsTrigger>
            <TabsTrigger value="anilist">AniList</TabsTrigger>
          </TabsList>
          {error || loadingError ? (
            <Alert>
              <AlertDescription>
                {error ?? "Impossible de charger les automatisations"}
              </AlertDescription>
            </Alert>
          ) : null}
          {state ? (
            <>
              <TabsContent value="anilist">
                <AniListPanel
                  action={action}
                  automations={state.automations}
                  busy={busy}
                  destinationField={
                    <DestinationField
                      onChange={(value) => {
                        setTarget(value);
                        reset();
                      }}
                      value={target}
                    />
                  }
                  destinations={dashboard.destinations}
                  key={target}
                  plugin={state.plugins.find((plugin) => plugin.id === "anilist")}
                  reloadPlugins={reload}
                  renderTemplate={(template, onChange) => (
                    <RuleFields draft={template} onChange={onChange} />
                  )}
                  target={target}
                />
              </TabsContent>
              <TabsContent value="plugins">
                <div className="plugins-intro">
                  <span className="automation-caption">PLUGINS INCLUS</span>
                  <p>Activez uniquement les sources que vous souhaitez utiliser.</p>
                </div>
                <div className="plugin-grid">
                  {state.plugins.map((plugin) => (
                    <PluginCard
                      action={action}
                      busy={busy}
                      key={plugin.id}
                      plugin={plugin}
                      reload={reload}
                    />
                  ))}
                </div>
              </TabsContent>
              <TabsContent value="discover">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    action(async () =>
                      setDiscovery(
                        await request<DiscoveryResult>("/discover", "POST", {
                          query: search,
                          sources: selectedSources.map((plugin) => plugin.id),
                        })
                      )
                    );
                  }}
                >
                  <FieldGroup>
                    <FieldSet disabled={busy}>
                      <FieldLegend variant="label">Sources</FieldLegend>
                      {activeSources.length ? (
                        <FieldGroup className="discovery-sources">
                          <Field orientation="horizontal">
                            <Checkbox
                              checked={selectedSources.length === activeSources.length}
                              disabled={busy}
                              id="discovery-all-sources"
                              indeterminate={
                                selectedSources.length > 0 &&
                                selectedSources.length < activeSources.length
                              }
                              onCheckedChange={(checked) => {
                                setExcludedSources(
                                  checked === true ? [] : activeSources.map((plugin) => plugin.id)
                                );
                                setDiscovery(null);
                              }}
                            />
                            <FieldLabel htmlFor="discovery-all-sources">Toutes</FieldLabel>
                          </Field>
                          {activeSources.map((plugin) => (
                            <Field key={plugin.id} orientation="horizontal">
                              <Checkbox
                                checked={!excludedSources.includes(plugin.id)}
                                disabled={busy}
                                id={`discovery-source-${plugin.id}`}
                                onCheckedChange={(checked) => {
                                  setExcludedSources((previous) =>
                                    checked === true
                                      ? previous.filter((id) => id !== plugin.id)
                                      : [...previous, plugin.id]
                                  );
                                  setDiscovery(null);
                                }}
                              />
                              <FieldLabel htmlFor={`discovery-source-${plugin.id}`}>
                                {plugin.name}
                              </FieldLabel>
                            </Field>
                          ))}
                        </FieldGroup>
                      ) : (
                        <FieldDescription>
                          Activez une source dans l’onglet Plugins pour rechercher.
                        </FieldDescription>
                      )}
                    </FieldSet>
                    <div className="automation-search">
                      <Field>
                        <FieldLabel htmlFor="feed-search">
                          {naturalSearch
                            ? "Recherche naturelle dans les sources"
                            : "Recherche classique dans les sources"}
                        </FieldLabel>
                        <Input
                          disabled={busy || !activeSources.length}
                          id="feed-search"
                          onChange={(event) => setSearch(event.target.value)}
                          placeholder={
                            naturalSearch ? "re zero ep9 saison4" : "Un titre, des mots-clés…"
                          }
                          required
                          value={search}
                        />
                      </Field>
                      <Button
                        disabled={busy || !selectedSources.length || !search.trim()}
                        type="submit"
                      >
                        {busy ? (
                          <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
                        ) : (
                          <SearchIcon data-icon="inline-start" />
                        )}
                        {busy ? "Recherche…" : "Rechercher"}
                      </Button>
                    </div>
                    <FieldDescription>
                      {naturalSearch
                        ? "Indiquez le titre, la saison et l’épisode dans l’ordre que vous voulez. Les titres anglais et japonais sont recherchés automatiquement."
                        : "Vos mots-clés sont recherchés tels quels. Activez et configurez Jev dans Plugins pour utiliser la recherche naturelle."}
                    </FieldDescription>
                  </FieldGroup>
                </form>
                <DestinationField
                  onChange={(value) => {
                    setTarget(value);
                    reset();
                  }}
                  value={target}
                />
                {discovery?.search?.warning ? (
                  <Alert>
                    <AlertDescription>{discovery.search.warning}</AlertDescription>
                  </Alert>
                ) : null}
                {discovery?.search?.title ? (
                  <div aria-live="polite" className="discovery-summary">
                    <strong>{discovery.search.title}</strong>
                    {discovery.search.season === null ? null : (
                      <Badge variant="secondary">Saison {discovery.search.season}</Badge>
                    )}
                    {discovery.search.episode === null ? null : (
                      <Badge variant="secondary">Épisode {discovery.search.episode}</Badge>
                    )}
                    <span>
                      {discovery.releases.length} résultat{discovery.releases.length > 1 ? "s" : ""}
                    </span>
                  </div>
                ) : null}
                {discovery?.errors.map((item) => (
                  <Alert key={item.sourceId}>
                    <AlertDescription>
                      {sourceNames[item.sourceId]} : {item.message}
                    </AlertDescription>
                  </Alert>
                ))}
                {discovery?.releases.map((release) => (
                  <ReleaseRow key={`${release.sourceId}:${release.id}`} release={release}>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          await request("/discover/add", "POST", {
                            destinationId: target,
                            id: release.id,
                            paused: false,
                            sourceId: release.sourceId,
                          });
                          await refresh();
                        })
                      }
                      size="sm"
                      variant="outline"
                    >
                      <PlusIcon data-icon="inline-start" />
                      Ajouter
                    </Button>
                  </ReleaseRow>
                ))}
                {!discovery?.releases.length && (
                  <QuietEmpty
                    description={
                      discovery
                        ? "Essayez un autre titre, une autre saison ou élargissez les sources sélectionnées."
                        : "Choisissez vos sources et recherchez une série, une saison ou un épisode."
                    }
                    title={discovery ? "Aucune sortie trouvée" : "Une recherche, plusieurs sources"}
                  />
                )}
              </TabsContent>
              <TabsContent value="automations">
                <DestinationField
                  onChange={(value) => {
                    setTarget(value);
                    reset();
                  }}
                  value={target}
                />
                <div className="automation-destination-path">{destination?.downloadPath}</div>
                <form onSubmit={interpret}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="automation-query">
                        Que souhaitez-vous télécharger ?
                      </FieldLabel>
                      <Textarea
                        id="automation-query"
                        onChange={(event) => {
                          setQuery(event.target.value);
                          setDraft(null);
                          setPreview(null);
                        }}
                        placeholder="Télécharge les nouveaux épisodes d’Ao Ashi saison 2 en VF, préfère 1080p puis 720p, avec Tsundere-Raws avant Nyaa."
                        required
                        rows={3}
                        value={query}
                      />
                      <FieldDescription>
                        {state.plugins.find((plugin) => plugin.id === "jev")?.enabled
                          ? "Jev interprète la demande. Vérifiez ensuite les critères proposés."
                          : "Sans Jev : renseignez un nom exact ou un pattern et ajustez les critères ci-dessous."}
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                  <div className="automation-form-actions">
                    <Button disabled={busy || !query.trim()} type="submit" variant="outline">
                      {busy ? (
                        <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
                      ) : (
                        <ZapIcon data-icon="inline-start" />
                      )}
                      Préparer la règle
                    </Button>
                    {editId !== null && (
                      <Button onClick={reset} type="button" variant="ghost">
                        Annuler la modification
                      </Button>
                    )}
                  </div>
                </form>
                {draft !== null && (
                  <div className="automation-editor">
                    <RuleFields
                      draft={draft}
                      onChange={(value) => {
                        setDraft(value);
                        setPreview(null);
                      }}
                    />
                    <div className="automation-form-actions">
                      <Button
                        disabled={busy}
                        onClick={() =>
                          action(async () =>
                            setPreview(
                              await request<Preview>("/automations/preview", "POST", draft)
                            )
                          )
                        }
                        variant="outline"
                      >
                        Prévisualiser les correspondances
                      </Button>
                      <Button
                        disabled={busy || !draft.title.trim() || !draft.sources.length}
                        onClick={save}
                      >
                        <CheckIcon data-icon="inline-start" />
                        {editId ? "Enregistrer les modifications" : "Créer l’automatisation"}
                      </Button>
                    </div>
                    {preview !== null && (
                      <div className="automation-preview">
                        <span className="automation-caption">
                          APERÇU · {preview.candidates.length} SORTIE(S)
                        </span>
                        {preview.errors.map((item) => (
                          <Alert key={item.sourceId}>
                            <AlertDescription>
                              {sourceNames[item.sourceId]} : {item.message}
                            </AlertDescription>
                          </Alert>
                        ))}
                        {preview.candidates.map((candidate) => (
                          <ReleaseRow
                            key={`${candidate.release.sourceId}:${candidate.release.id}`}
                            release={candidate.release}
                          >
                            <Badge variant="outline">
                              {candidate.reason ??
                                (candidate.uncertain ? "À vérifier" : "Correspond")}
                            </Badge>
                          </ReleaseRow>
                        ))}
                        {!preview.candidates.length && (
                          <p>Aucune sortie disponible pour cet aperçu.</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="automation-section-heading">
                  <span className="automation-caption">RÈGLES DE CE THREAD · {rules.length}</span>
                  <Button disabled={busy} onClick={() => action(reload)} size="sm" variant="ghost">
                    <RefreshCwIcon data-icon="inline-start" />
                    Actualiser
                  </Button>
                </div>
                {rules.map((rule) => (
                  <article className="automation-rule" key={rule.id}>
                    <div className="automation-row-heading">
                      <strong>{rule.title}</strong>
                      <Badge variant={rule.status === "active" ? "secondary" : "outline"}>
                        {ruleStatuses[rule.status]}
                      </Badge>
                    </div>
                    <p>{rule.query}</p>
                    <div className="feed-release-meta">
                      <span>{rule.sources.map((id) => sourceNames[id]).join(" → ")}</span>
                      <span>{rule.resolutions.join(" → ") || "Toutes résolutions"}</span>
                      <span>{rule.languages.join(" → ") || "Toutes langues"}</span>
                    </div>
                    {rule.error !== null && (
                      <Alert>
                        <AlertDescription>{rule.error}</AlertDescription>
                      </Alert>
                    )}
                    <div className="automation-rule-actions">
                      <Button
                        disabled={busy}
                        onClick={() =>
                          action(async () => {
                            await request(`/automations/${rule.id}/run`, "POST", {});
                            await reload();
                            await refresh();
                          })
                        }
                        size="sm"
                        variant="outline"
                      >
                        <PlayIcon data-icon="inline-start" />
                        Vérifier maintenant
                      </Button>
                      <Button onClick={() => edit(rule)} size="sm" variant="ghost">
                        Modifier
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          action(async () => {
                            await request(`/automations/${rule.id}`, "PUT", {
                              ...rule,
                              enabled: !rule.enabled,
                            });
                            await reload();
                          })
                        }
                        size="sm"
                        variant="ghost"
                      >
                        {rule.enabled ? "Suspendre" : "Activer"}
                      </Button>
                      <ActionTooltip>
                        <Button
                          aria-label={`Supprimer l’automatisation ${rule.title}`}
                          disabled={busy}
                          onClick={() =>
                            action(async () => {
                              await request(`/automations/${rule.id}`, "DELETE", undefined);
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
                    <span className="automation-caption">
                      {rule.lastRunAt
                        ? `Dernière vérification : ${new Date(rule.lastRunAt).toLocaleString("fr-FR")}`
                        : "Vérifiée au prochain démarrage"}
                    </span>
                  </article>
                ))}
                {!(rules.length || draft) && (
                  <QuietEmpty
                    description="Décrivez votre demande, choisissez vos priorités et laissez Tofu suivre les sorties de ce thread."
                    title="Votre première automatisation"
                  />
                )}
              </TabsContent>
              <TabsContent value="history">
                <DestinationField onChange={setTarget} value={target} />
                <div className="automation-section-heading">
                  <span className="automation-caption">DÉCISIONS DE CE THREAD</span>
                  <Button disabled={busy} onClick={() => action(reload)} size="sm" variant="ghost">
                    <RefreshCwIcon data-icon="inline-start" />
                    Actualiser
                  </Button>
                </div>
                {decisions.map((decision) => (
                  <div className="automation-history-item" key={decision.id}>
                    <ReleaseRow release={decision.release}>
                      <Badge variant={decision.status === "added" ? "secondary" : "outline"}>
                        {decisionStatuses[decision.status]}
                      </Badge>
                    </ReleaseRow>
                    <p>
                      {decision.reason}
                      {decision.probability === null
                        ? ""
                        : ` · Jev : ${Math.round(decision.probability * 100)} %`}
                    </p>
                    {decision.deadline !== null && decision.status === "waiting" && (
                      <span className="automation-caption">
                        Choix prévu à {new Date(decision.deadline).toLocaleTimeString("fr-FR")}
                      </span>
                    )}
                    {["review", "waiting", "error"].includes(decision.status) && (
                      <div className="flex gap-2">
                        <Button
                          disabled={busy}
                          onClick={() =>
                            action(async () => {
                              await request(
                                `/automation-decisions/${encodeURIComponent(decision.id)}/approve`,
                                "POST",
                                {}
                              );
                              await reload();
                              await refresh();
                            })
                          }
                          size="sm"
                        >
                          Télécharger cette version
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            action(async () => {
                              await request(
                                `/automation-decisions/${encodeURIComponent(decision.id)}/ignore`,
                                "POST",
                                {}
                              );
                              await reload();
                            })
                          }
                          size="sm"
                          variant="ghost"
                        >
                          Ignorer
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
                {!decisions.length && (
                  <QuietEmpty
                    description="Les versions choisies, les attentes et les sorties ignorées apparaîtront ici."
                    title="Aucune décision pour le moment"
                  />
                )}
              </TabsContent>
            </>
          ) : (
            <Skeleton className="h-40" />
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
function DestinationField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { data } = useDashboard();
  return (
    <Field className="automation-target">
      <FieldLabel htmlFor="automation-destination">Thread de destination</FieldLabel>
      <Select
        items={data.destinations.map((destination) => ({
          label: destination.name,
          value: destination.id,
        }))}
        onValueChange={(next) => {
          if (next !== null) {
            onChange(next);
          }
        }}
        value={value}
      >
        <SelectTrigger className="w-full" id="automation-destination">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {data.destinations.map((destination) => (
              <SelectItem key={destination.id} value={destination.id}>
                {destination.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}
