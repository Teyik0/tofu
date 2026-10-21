import {
  ArrowUpDownIcon,
  Grid3x3Icon,
  LayoutGridIcon,
  ListIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  TagsIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { ActionTooltip } from "../../components/action-tooltip";
import { OptionSelect } from "../../components/option-select";
import { Button } from "../../components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../../components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import type { useAniListCatalog } from "../../hooks/use-anilist-catalog";
import {
  BrowseAdvancedFilters,
  CatalogMultiSelectFilter,
  CatalogSelectFilter,
  GenreTagFilter,
} from "./_browse-filters";
import {
  formatLabel,
  progressOptions,
  type SortValue,
  seasonOptions,
  trackingOptions,
  type useLibraryFilters,
} from "./_library-filters";

type FilterModel = ReturnType<typeof useLibraryFilters>;
type CatalogModel = ReturnType<typeof useAniListCatalog>;
type ViewValue = "cards" | "compact" | "list";
const viewOptions = [
  { icon: LayoutGridIcon, label: "Large cards", value: "cards" },
  { icon: Grid3x3Icon, label: "Compact cards", value: "compact" },
  { icon: ListIcon, label: "List", value: "list" },
] satisfies { icon: typeof ListIcon; label: string; value: ViewValue }[];

export function LibraryControls({
  model,
  browsing,
  catalog,
  search,
  setSearch,
  sort,
  setSort,
  availableSorts,
  view,
  setView,
}: {
  model: FilterModel;
  browsing: boolean;
  catalog: CatalogModel;
  search: string;
  setSearch: (value: string) => void;
  sort: SortValue;
  setSort: (value: SortValue) => void;
  availableSorts: { label: string; value: SortValue }[];
  view: ViewValue;
  setView: (value: ViewValue) => void;
}) {
  const { filters, update, activeFilters, genres, years, formats, entries } = model;
  const [advanced, setAdvanced] = useState(false);
  const catalogOptions = catalog.options;
  const currentCatalog = catalog.data;
  const loadingCatalog = catalog.loading;
  return (
    <>
      {" "}
      <div className="anilist-filters">
        <div className="anilist-filter">
          <label htmlFor="anime-search">Search</label>
          <InputGroup className="anilist-search">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search anime"
              id="anime-search"
              onChange={(event) => setSearch(event.target.value)}
              value={search}
            />
            {search ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  size="icon-xs"
                >
                  <XIcon />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        </div>
        <GenreTagFilter
          filters={filters}
          genres={genres}
          options={catalogOptions}
          update={update}
        />
        <CatalogSelectFilter
          id="anilist-year"
          label="Year"
          onValueChange={(year) => update({ year })}
          options={[
            { label: "Any", value: "any" },
            ...years.map((year) => ({ label: year, value: year })),
          ]}
          value={filters.year}
        />

        <CatalogSelectFilter
          id="anilist-season"
          label="Season"
          onValueChange={(season) => update({ season })}
          options={seasonOptions}
          value={filters.season}
        />

        <CatalogMultiSelectFilter
          id="anilist-format"
          label="Format"
          onValueChange={(selectedFormats) => update({ formats: selectedFormats })}
          options={formats.map((format) => ({ label: formatLabel(format), value: format }))}
          value={filters.formats}
        />

        <ActionTooltip>
          <Button
            aria-expanded={advanced}
            aria-label="More filters"
            className="anilist-advanced-toggle"
            data-active={advanced || activeFilters.length > 0}
            onClick={() => setAdvanced(!advanced)}
            size="icon"
            variant="ghost"
          >
            <SlidersHorizontalIcon />
          </Button>
        </ActionTooltip>
      </div>
      {advanced ? (
        <div className="anilist-advanced">
          <BrowseAdvancedFilters
            filters={filters}
            genres={genres}
            options={catalogOptions}
            update={update}
          />
          {browsing ? null : (
            <>
              <div className="anilist-filter">
                <label htmlFor="anilist-tracking">Automation</label>
                <OptionSelect
                  className="anilist-filter-trigger"
                  disabled={false}
                  id="anilist-tracking"
                  onValueChange={(tracking) => update({ tracking })}
                  options={trackingOptions}
                  value={filters.tracking}
                />
              </div>
              <div className="anilist-filter">
                <label htmlFor="anilist-progress">Progress</label>
                <OptionSelect
                  className="anilist-filter-trigger"
                  disabled={false}
                  id="anilist-progress"
                  onValueChange={(progress) => update({ progress })}
                  options={progressOptions}
                  value={filters.progress}
                />
              </div>
            </>
          )}
        </div>
      ) : null}
      <div className="anilist-results-bar">
        <fieldset aria-label="Active filters" className="anilist-active-filters">
          {activeFilters.length ? (
            <TagsIcon aria-hidden="true" className="anilist-filter-tag" />
          ) : null}
          {activeFilters.map((filter) => (
            <button
              aria-label={`Remove filter ${filter.label}`}
              className="anilist-filter-chip"
              key={filter.key}
              onClick={filter.clear}
              title={`Remove ${filter.label}`}
              type="button"
            >
              {filter.label}
              <XIcon aria-hidden="true" />
            </button>
          ))}
          {activeFilters.length ? (
            <button
              className="anilist-filter-chip anilist-clear-filters"
              onClick={() => model.clear()}
              type="button"
            >
              Clear All
              <XIcon aria-hidden="true" />
            </button>
          ) : null}
          <span className="anilist-title-count">
            {browsing
              ? loadingCatalog
                ? "—"
                : currentCatalog
                  ? entries.length
                  : "—"
              : entries.length}
            {browsing && currentCatalog?.hasNextPage ? "+" : ""} title
            {entries.length === 1 ? "" : "s"}
          </span>
        </fieldset>
        <div className="anilist-view-controls">
          <Select
            items={availableSorts}
            onValueChange={(value) => {
              if (value !== null) {
                setSort(value);
              }
            }}
            value={sort}
          >
            <SelectTrigger aria-label="Sort anime" className="anilist-sort" size="sm">
              <ArrowUpDownIcon />
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" alignItemWithTrigger={false} className="anilist-select-menu">
              <SelectGroup>
                {availableSorts.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <span aria-hidden="true" className="toolbar-divider" />
          <fieldset aria-label="Layout" className="anilist-views">
            {viewOptions.map((option) => {
              const Glyph = option.icon;
              return (
                <ActionTooltip key={option.value}>
                  <Button
                    aria-label={option.label}
                    aria-pressed={view === option.value}
                    onClick={() => setView(option.value)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Glyph />
                  </Button>
                </ActionTooltip>
              );
            })}
          </fieldset>
        </div>
      </div>
    </>
  );
}
