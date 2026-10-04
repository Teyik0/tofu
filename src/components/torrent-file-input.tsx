import { FileCheckIcon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { bytes } from "./format";
import { Button } from "./ui/button";
import { Field, FieldLabel } from "./ui/field";

export function TorrentFileInput({
  file,
  disabled,
  onChange,
  onError,
}: {
  file: File | null;
  disabled: boolean;
  onChange: (file: File | null) => void;
  onError: (message: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const choose = (files: File[]) => {
    if (disabled) {
      return;
    }
    const [selected] = files;
    if (files.length !== 1 || !selected?.name.toLowerCase().endsWith(".torrent")) {
      onError("Choose a single .torrent file.");
      return;
    }
    onError(null);
    onChange(selected);
  };
  return (
    <Field className="torrent-file-field">
      <FieldLabel className="sr-only" htmlFor="torrent-file">
        .torrent file
      </FieldLabel>
      <input
        accept=".torrent,application/x-bittorrent"
        className="sr-only"
        disabled={disabled}
        id="torrent-file"
        onChange={(event) => choose(Array.from(event.target.files ?? []))}
        ref={input}
        tabIndex={-1}
        type="file"
      />
      <Button
        aria-label="Choose a .torrent file"
        className="torrent-file-dropzone"
        data-dragging={dragging}
        data-selected={file !== null}
        disabled={disabled}
        onClick={() => input.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          event.stopPropagation();
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false);
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          choose(Array.from(event.dataTransfer.files));
        }}
        type="button"
        variant="outline"
      >
        <span className="torrent-file-symbol">{file ? <FileCheckIcon /> : <UploadIcon />}</span>
        <span className="torrent-file-copy">
          {file ? (
            <>
              <strong data-file-name>{file.name}</strong>
              <span>{bytes(file.size)} · Click to change file</span>
            </>
          ) : (
            <>
              <strong>Drop your .torrent file here</strong>
              <span>
                or <span className="torrent-file-browse">browse files</span>
              </span>
            </>
          )}
        </span>
      </Button>
      {file !== null && (
        <Button
          className="self-end"
          disabled={disabled}
          onClick={() => {
            if (input.current) {
              input.current.value = "";
            }
            onChange(null);
            onError(null);
          }}
          size="xs"
          type="button"
          variant="ghost"
        >
          Remove file
        </Button>
      )}
    </Field>
  );
}
