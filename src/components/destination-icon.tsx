import {
  ArchiveIcon,
  BookOpenIcon,
  CloudIcon,
  CodeIcon,
  FilmIcon,
  FlameIcon,
  FolderIcon,
  Gamepad2Icon,
  HeartIcon,
  MusicIcon,
  StarIcon,
  TvIcon,
} from "lucide-react";
import { useId } from "react";
import { type DestinationIconName, destinationIconNames } from "../types";
import { FieldLabel, FieldLegend, FieldSet } from "./ui/field";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";

const threadIcons = {
  archive: { icon: ArchiveIcon, label: "Archive" },
  book: { icon: BookOpenIcon, label: "Book" },
  cloud: { icon: CloudIcon, label: "Cloud" },
  code: { icon: CodeIcon, label: "Code" },
  film: { icon: FilmIcon, label: "Film" },
  flame: { icon: FlameIcon, label: "Flame" },
  folder: { icon: FolderIcon, label: "Folder" },
  gamepad: { icon: Gamepad2Icon, label: "Gamepad" },
  heart: { icon: HeartIcon, label: "Heart" },
  music: { icon: MusicIcon, label: "Music" },
  star: { icon: StarIcon, label: "Star" },
  tv: { icon: TvIcon, label: "TV" },
} satisfies Record<DestinationIconName, { icon: typeof FolderIcon; label: string }>;

export function DestinationIcon({ name }: { name: DestinationIconName }) {
  const Glyph = threadIcons[name].icon;
  return <Glyph aria-hidden="true" />;
}

export function DestinationIconPicker({
  value,
  onChange,
  disabled,
}: {
  value: DestinationIconName;
  onChange: (value: DestinationIconName) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <FieldSet>
      <FieldLegend variant="label">Thread icon</FieldLegend>
      <RadioGroup
        aria-label="Thread icon"
        className="thread-icon-picker"
        disabled={disabled}
        onValueChange={(selected) => {
          const name = destinationIconNames.find((key) => key === selected);
          if (name) {
            onChange(name);
          }
        }}
        value={value}
      >
        {destinationIconNames.map((name) => {
          const { icon: Glyph, label } = threadIcons[name];
          return (
            <FieldLabel
              className="thread-icon-choice"
              data-selected={value === name}
              htmlFor={`${id}-${name}`}
              key={name}
              title={`${label} icon`}
            >
              <RadioGroupItem
                aria-label={`${label} icon`}
                className="sr-only"
                id={`${id}-${name}`}
                value={name}
              />
              <Glyph aria-hidden="true" />
            </FieldLabel>
          );
        })}
      </RadioGroup>
    </FieldSet>
  );
}
