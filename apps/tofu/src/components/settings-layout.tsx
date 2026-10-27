import { Link, useRouter } from "@teyik0/furin/link";
import { Button, buttonVariants } from "@tofu/ui/button";
import { useAtomValue } from "jotai";
import { ArrowLeftIcon, type LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { backToWorkspace } from "../lib/navigation";
import { settingsBackPathAtom } from "../state/workspace";
import { Logo } from "./icon";
import { SidebarUpdateAction } from "./updates";

type SettingsPath =
  | "/options"
  | "/options/preferences"
  | "/options/appearance"
  | "/options/downloads"
  | "/options/connections"
  | "/options/updates"
  | "/plugins"
  | "/plugins/sources"
  | "/plugins/integrations";

export function SettingsLayout({
  title,
  path,
  sections,
  navigationLabel,
  className,
  backClassName,
  contentClassName,
  actions,
  children,
}: {
  title: string;
  path: string;
  sections: readonly { icon: LucideIcon; label: string; to: SettingsPath }[];
  navigationLabel: string;
  className?: string;
  backClassName?: string;
  contentClassName?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 520px)");
    const revealActiveSection = () => {
      if (mobile.matches) {
        navigation.current?.querySelector(`[href="${CSS.escape(path)}"]`)?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
      }
    };
    revealActiveSection();
    mobile.addEventListener("change", revealActiveSection);
    return () => mobile.removeEventListener("change", revealActiveSection);
  }, [path]);
  const router = useRouter();
  const backPath = useAtomValue(settingsBackPathAtom);
  return (
    <div className={`settings-page${className ? ` ${className}` : ""}`}>
      <aside className="settings-navigation">
        <div className="settings-brand">
          <Logo />
          <strong>Tofu</strong>
        </div>
        <nav aria-label={navigationLabel} ref={navigation}>
          {sections.map(({ to, label, icon: Icon }) => (
            <Link
              aria-current={path === to ? "page" : undefined}
              className={buttonVariants({
                className: "settings-nav-item",
                variant: path === to ? "secondary" : "ghost",
              })}
              key={to}
              preload={false}
              resetScroll={false}
              to={to}
            >
              <Icon data-icon="inline-start" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="settings-footer">
          <Button
            className={`settings-back${backClassName ? ` ${backClassName}` : ""}`}
            onClick={() => void backToWorkspace(router, backPath)}
            variant="ghost"
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
          <SidebarUpdateAction />
        </div>
      </aside>
      <main className="settings-main">
        <header className="settings-topbar">
          <h1>
            <span>{title}</span>
            <span aria-hidden="true">/</span>
            {sections.find((item) => item.to === path)?.label}
          </h1>
          {actions}
        </header>
        <div className={`settings-content${contentClassName ? ` ${contentClassName}` : ""}`}>
          {children}
        </div>
      </main>
    </div>
  );
}
