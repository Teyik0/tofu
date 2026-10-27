import { useMemo } from "react";
import { encode } from "uqr";

/** A real, scannable QR code drawn from the encoded module matrix. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const matrix = useMemo(() => encode(value, { border: 2 }).data, [value]);
  const size = matrix.length;
  return (
    <svg
      aria-label={label}
      className="connections-qr"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <rect fill="#fff" height={size} width={size} />
      <path
        d={matrix
          .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : "")))
          .join("")}
        fill="#1d211b"
      />
    </svg>
  );
}
