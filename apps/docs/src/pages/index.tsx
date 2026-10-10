import { defineRoute } from "@teyik0/furin";
import { Swarm } from "../components/swarm";
import { route as root } from "./root";

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Tofu — Your downloads, at ease." }] }))
  .page(() => (
    <main id="main">
      <section aria-labelledby="hero-title" className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" />A considered torrent client
          </p>
          <h1 id="hero-title">
            Your downloads.
            <br />
            <em>At ease.</em>
          </h1>
          <p className="hero-description">
            A calm place for your torrents.
            <br />
            Organize, discover, and let things flow.
          </p>
          <div className="hero-actions">
            <a className="button" href="https://github.com/Teyik0/Tofu/releases">
              Get Tofu <span aria-hidden="true">↗</span>
            </a>
            <a className="text-link" href="/docs">
              Make yourself at home <span aria-hidden="true">→</span>
            </a>
          </div>
          <p className="platform-note">
            macOS · Windows · Linux <span>Free & open source</span>
          </p>
        </div>
        <div className="hero-art">
          <Swarm />
          <span className="art-caption">Small pieces. Better together.</span>
        </div>
      </section>
      <section aria-label="What makes Tofu different" className="feature-strip">
        <div>
          <span className="feature-index">01 /</span>
          <h2>A place for everything</h2>
          <p>Give every thread its own folder.</p>
        </div>
        <div>
          <span className="feature-index">02 /</span>
          <h2>Quietly in control</h2>
          <p>Real stats. Your files stay yours.</p>
        </div>
        <div>
          <span className="feature-index">03 /</span>
          <h2>Room for your ideas</h2>
          <p>Extend your space with plugins.</p>
        </div>
      </section>
      <a className="plugin-invitation" href="/docs/plugins">
        <span>For the curious & the makers</span>
        <span>
          Build a little something for Tofu. <span aria-hidden="true">↗</span>
        </span>
      </a>
    </main>
  ));
