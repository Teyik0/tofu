import type { ReactNode } from "react";

export function Code({ children }: { children: string }) {
  return (
    <pre>
      <code>{children}</code>
    </pre>
  );
}

export function Callout({ children }: { children: ReactNode }) {
  return <aside className="callout">{children}</aside>;
}

export function DocTitle({
  title,
  description,
  label,
}: {
  title: string;
  description: string;
  label: string;
}) {
  return (
    <>
      <p className="eyebrow">{label}</p>
      <h1>{title}</h1>
      <p className="lead">{description}</p>
    </>
  );
}
