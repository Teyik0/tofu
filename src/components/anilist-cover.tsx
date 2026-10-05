import { BookOpenIcon } from "lucide-react";
import { useState } from "react";

export function AniListCover({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return src && !failed ? (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError handles a failed image request, not user interaction.
    <img alt="" height={300} loading="lazy" onError={() => setFailed(true)} src={src} width={200} />
  ) : (
    <BookOpenIcon aria-hidden="true" />
  );
}
