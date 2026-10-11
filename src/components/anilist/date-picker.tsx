import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import type { AniListDate } from "../../types";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** AniList dates can be partial, so only the known parts are shown. */
export function formatAniListDate(date: AniListDate | undefined) {
  if (!date?.year) {
    return null;
  }
  return [String(date.year), date.month ? pad(date.month) : null, date.day ? pad(date.day) : null]
    .filter((part) => part !== null)
    .join("-");
}

function calendarDays(year: number, month: number) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = Date.UTC(year, month - 1, 1 - first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => new Date(start + index * 86_400_000));
}

export function AniListDatePicker({
  id,
  label,
  value,
  disabled,
  change,
}: {
  id: string;
  label: string;
  value: AniListDate | undefined;
  disabled: boolean;
  change: (value: AniListDate) => void;
}) {
  const today = new Date();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(() => ({
    month: value?.month ?? today.getMonth() + 1,
    year: value?.year ?? today.getFullYear(),
  }));
  const shift = (months: number) =>
    setVisible((current) => {
      const index = current.year * 12 + current.month - 1 + months;
      return { month: (index % 12) + 1, year: Math.floor(index / 12) };
    });
  const formatted = formatAniListDate(value);
  return (
    <div className="anilist-filter-control" data-selected={formatted !== null}>
      <Popover
        onOpenChange={(next) => {
          if (next) {
            setVisible({
              month: value?.month ?? today.getMonth() + 1,
              year: value?.year ?? today.getFullYear(),
            });
          }
          setOpen(next);
        }}
        open={open}
      >
        <PopoverTrigger
          aria-label={`${label}: ${formatted ?? "not set"}`}
          className="anime-date-trigger"
          disabled={disabled}
          id={id}
        >
          <CalendarIcon aria-hidden="true" />
          <span>{formatted ?? ""}</span>
        </PopoverTrigger>
        <PopoverContent align="start" className="anime-calendar" sideOffset={8}>
          <div className="anime-calendar-header">
            <Button
              aria-label="Previous year"
              onClick={() => shift(-12)}
              size="icon-sm"
              variant="ghost"
            >
              <ChevronsLeftIcon />
            </Button>
            <Button
              aria-label="Previous month"
              onClick={() => shift(-1)}
              size="icon-sm"
              variant="ghost"
            >
              <ChevronLeftIcon />
            </Button>
            <strong aria-live="polite">
              {visible.year}{" "}
              <span>{monthName.format(new Date(Date.UTC(visible.year, visible.month - 1)))}</span>
            </strong>
            <Button aria-label="Next month" onClick={() => shift(1)} size="icon-sm" variant="ghost">
              <ChevronRightIcon />
            </Button>
            <Button aria-label="Next year" onClick={() => shift(12)} size="icon-sm" variant="ghost">
              <ChevronsRightIcon />
            </Button>
          </div>
          <div className="anime-calendar-grid">
            {weekdays.map((weekday) => (
              <span aria-hidden="true" className="anime-calendar-weekday" key={weekday}>
                {weekday}
              </span>
            ))}
            {calendarDays(visible.year, visible.month).map((day) => {
              const date = {
                day: day.getUTCDate(),
                month: day.getUTCMonth() + 1,
                year: day.getUTCFullYear(),
              };
              return (
                <button
                  aria-label={`${date.year}-${pad(date.month)}-${pad(date.day)}`}
                  aria-pressed={
                    value?.year === date.year &&
                    value.month === date.month &&
                    value.day === date.day
                  }
                  className="anime-calendar-day"
                  data-outside={date.month !== visible.month}
                  data-today={
                    date.year === today.getFullYear() &&
                    date.month === today.getMonth() + 1 &&
                    date.day === today.getDate()
                  }
                  key={day.getTime()}
                  onClick={() => {
                    change(date);
                    setOpen(false);
                  }}
                  type="button"
                >
                  {date.day}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      {formatted === null || disabled ? null : (
        <Button
          aria-label={`Clear ${label.toLowerCase()}`}
          className="anilist-filter-clear"
          onClick={() => change({ day: null, month: null, year: null })}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}
