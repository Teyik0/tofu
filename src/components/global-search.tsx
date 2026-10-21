import { Autocomplete } from "@base-ui/react/autocomplete";
import { useAtom, useSetAtom } from "jotai";
import { HistoryIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { LiveState } from "../api/modules/dashboard/projection";
import { globalSearchOpenAtom } from "../state/workspace";
import {
  GlobalSearchResults,
  GlobalSearchReview,
  GlobalSearchSourceStatus,
} from "./global-search-results";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Field, FieldLabel } from "./ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { type SearchItem, useGlobalSearch } from "./use-global-search";

export function GlobalSearchTrigger() {
  const setOpen = useSetAtom(globalSearchOpenAtom);
  return (
    <Button
      aria-keyshortcuts="Meta+k Control+k"
      aria-label="Search everything"
      className="global-search-trigger"
      onClick={() => setOpen(true)}
      variant="outline"
    >
      <SearchIcon data-icon="inline-start" />
      <span>Search everything…</span>
      <kbd>⌘ K</kbd>
    </Button>
  );
}

export function GlobalSearch({
  dashboard,
  activeDestination,
}: {
  dashboard: LiveState;
  activeDestination: string | null;
}) {
  const [open, setOpen] = useAtom(globalSearchOpenAtom);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      const otherDialog = document.querySelector(
        '[role="dialog"][data-open]:not(.global-search-dialog), [role="alertdialog"][data-open]'
      );
      if (otherDialog) {
        return;
      }
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [setOpen]);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="global-search-dialog" initialFocus={inputRef} showCloseButton>
        <DialogTitle className="sr-only">Search everything</DialogTitle>
        <DialogDescription className="sr-only">
          Find torrents across every thread and search your enabled sources. Review a release before
          downloading.
        </DialogDescription>
        {!!open && (
          <SearchContent
            activeDestination={activeDestination}
            close={() => setOpen(false)}
            dashboard={dashboard}
            inputRef={inputRef}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function itemLabel(item: SearchItem) {
  return item.kind === "torrent" ? item.torrent.name : (item.group.releases[0]?.title ?? "Release");
}

function SearchContent({
  dashboard,
  activeDestination,
  close,
  inputRef,
}: {
  dashboard: LiveState;
  activeDestination: string | null;
  close: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const model = useGlobalSearch({ activeDestination, close, dashboard });
  const {
    recent,
    query,
    scope,
    setScope,
    setReview,
    notice,
    busy,
    error,
    items,
    currentReview,
    release,
    loading,
    updateQuery,
  } = model;
  return (
    <Autocomplete.Root<SearchItem>
      autoHighlight="always"
      filter={null}
      inline
      items={items}
      itemToStringValue={itemLabel}
      mode="none"
      onValueChange={(value, details) => {
        if (details.reason === "item-press") {
          details.cancel();
        } else {
          updateQuery(value);
        }
      }}
      open
      value={query}
    >
      <div className="global-search-heading">
        <Field>
          <FieldLabel className="sr-only" htmlFor="global-search-input">
            Search everything
          </FieldLabel>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <Autocomplete.Input
              aria-label="Search everything"
              disabled={busy}
              id="global-search-input"
              maxLength={1000}
              placeholder="Search torrents and sources…"
              ref={inputRef}
              render={<InputGroupInput />}
            />
            <InputGroupAddon align="inline-end">
              <kbd>Esc</kbd>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      </div>
      <Tabs
        className="global-search-tabs"
        onValueChange={(value) => {
          if (value === "all" || value === "torrents" || value === "sources") {
            setScope(value);
            setReview(null);
          }
        }}
        value={scope}
      >
        <TabsList aria-label="Search scope" className="global-search-scopes" variant="line">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="torrents">My torrents</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
        </TabsList>
        <TabsContent className="global-search-body" value={scope}>
          {!query && recent.length > 0 && (
            <div className="global-search-recent">
              <span>
                <HistoryIcon /> Recent searches
              </span>
              <div>
                {recent.map((text) => (
                  <Button key={text} onClick={() => updateQuery(text)} size="sm" variant="ghost">
                    {text}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <GlobalSearchResults model={model} />
          {items.length === 0 && !loading && (
            <Empty className="global-search-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle>{query ? "No matches found" : "One search, every thread"}</EmptyTitle>
                <EmptyDescription>
                  {query
                    ? "Try another title or different keywords."
                    : "Find your downloads or discover a release from your enabled sources."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {scope !== "torrents" && <GlobalSearchSourceStatus close={close} model={model} />}
        </TabsContent>
      </Tabs>
      {!!(notice || error) && (
        <Alert className="global-search-feedback" variant={error ? "destructive" : "default"}>
          <AlertDescription role="status">{error ?? notice}</AlertDescription>
        </Alert>
      )}
      {!!currentReview && !!release && <GlobalSearchReview model={model} />}
      <footer className="global-search-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>↵</kbd> Open / Review
        </span>
        <span>
          <kbd>Esc</kbd> Close
        </span>
      </footer>
    </Autocomplete.Root>
  );
}
