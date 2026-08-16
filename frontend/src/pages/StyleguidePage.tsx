import { useState } from "react";

import {
  Banner,
  Button,
  Chip,
  Chips,
  EmptyState,
  Field,
  FieldRow,
  IconButton,
  LinkButton,
  Modal,
  PageHead,
  Panel,
  Switch,
  Toolbar,
} from "../components/ui";
import tokenGroups, { type Token, type TokenGroup } from "virtual:design-tokens";

/**
 * Where the design system is visible.
 *
 * The token half is parsed out of styles.css at build time rather than written
 * out here. A hand-kept swatch list is a second copy of the tokens, and the
 * whole point of the layer below is that there are no second copies: this page
 * would have started drifting the first time somebody added a colour.
 */

const isColour = (value: string) =>
  /^(#|rgb|hsl|color-mix|linear-gradient)/.test(value);

/**
 * Previews reference the token rather than the parsed string wherever they
 * can, so what you see is what the browser resolves - including the
 * color-mix() values, which have no meaning as raw text.
 */
function Preview({ name, value }: Token) {
  if (name.startsWith("--space-")) {
    return <span className="sg-bar" style={{ width: `var(${name})` }} />;
  }
  if (name.startsWith("--radius-")) {
    return <span className="sg-radius" style={{ borderRadius: `var(${name})` }} />;
  }
  if (/^--(shadow|ring)/.test(name) && value.includes("px")) {
    return <span className="sg-shadow" style={{ boxShadow: `var(${name})` }} />;
  }
  if (name.startsWith("--font-")) {
    return (
      <span className="sg-sample" style={{ fontFamily: `var(${name})` }}>
        Ag
      </span>
    );
  }
  if (name.startsWith("--text-")) {
    return (
      <span className="sg-sample" style={{ fontSize: `var(${name})` }}>
        Ag
      </span>
    );
  }
  if (name.startsWith("--weight-")) {
    return (
      <span className="sg-sample" style={{ fontWeight: `var(${name})` }}>
        Ag
      </span>
    );
  }
  if (isColour(value)) {
    return <span className="sg-swatch" style={{ background: `var(${name})` }} />;
  }
  return null;
}

function TokenList({ group }: { group: TokenGroup }) {
  return (
    <div className="sg-grid">
      {group.tokens.map((token) => (
        <div className="sg-token" key={token.name}>
          <Preview {...token} />
          <span className="sg-token-text">
            <span className="sg-token-name">{token.name}</span>
            <span className="sg-token-value" title={token.value}>
              {token.value}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="sg-section">
      <h2>{title}</h2>
      {note && <p className="sg-note">{note}</p>}
      {children}
    </section>
  );
}

export default function StyleguidePage() {
  const groups = tokenGroups;
  const [modalOpen, setModalOpen] = useState(false);
  const [stocked, setStocked] = useState(true);

  return (
    <>
      <PageHead title="Styleguide" sub={`${groups.length} token groups`}>
        <LinkButton to="/recipes">Back to app</LinkButton>
      </PageHead>

      <Section
        title="Buttons"
        note="Variants are closed: primary and danger are the only two ways to stand out, and there is no className to invent a third."
      >
        <div className="sg-row">
          <Button>Default</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="sg-row">
          <Button size="small">Default</Button>
          <Button size="small" variant="primary">
            Primary
          </Button>
          <Button size="small" variant="danger">
            Danger
          </Button>
          <Button size="small" disabled>
            Disabled
          </Button>
        </div>
        <div className="sg-row">
          <LinkButton to="/styleguide">Link button</LinkButton>
          <LinkButton to="/styleguide" variant="primary">
            Link primary
          </LinkButton>
          <IconButton label="An icon button">✕</IconButton>
        </div>
      </Section>

      <Section title="Chips">
        <Chips>
          <Chip>Neutral</Chip>
          <Chip tone="accent">Accent</Chip>
          <Chip tone="green">Green</Chip>
        </Chips>
      </Section>

      <Section
        title="Banners"
        note="Error is “that did not happen”; notice is worth knowing while the page stays usable."
      >
        <div className="sg-stack">
          <Banner tone="error">Something went wrong, and here is what.</Banner>
          <Banner tone="notice" role="status">
            <span>Showing the last version that loaded.</span>
            <Button size="small">Try again</Button>
          </Banner>
        </div>
      </Section>

      <Section title="Fields">
        <div className="sg-stack">
          <Field label="Title" htmlFor="sg-title">
            <input id="sg-title" placeholder="e.g. Weeknight chicken curry" />
          </Field>
          <Field
            label="Tags"
            htmlFor="sg-tags"
            hint="Comma separated, e.g. quick, vegetarian, weeknight."
          >
            <input id="sg-tags" placeholder="quick, vegetarian" />
          </Field>
          <FieldRow>
            <Field label="Prep (min)" htmlFor="sg-prep">
              <input id="sg-prep" type="number" />
            </Field>
            <Field label="Cook (min)" htmlFor="sg-cook">
              <input id="sg-cook" type="number" />
            </Field>
          </FieldRow>
        </div>
      </Section>

      <Section title="Panels">
        <div className="detail-cols">
          <Panel title="Plain">
            <p className="empty-note">A panel with nothing beside its title.</p>
          </Panel>
          <Panel title="With an action" action={<Chip tone="accent">4 servings</Chip>}>
            <p className="empty-note">The action sits on the title’s baseline.</p>
          </Panel>
        </div>
      </Section>

      <Section title="Switch">
        <div className="sg-row">
          <Switch on={stocked} onToggle={() => setStocked((v) => !v)}>
            {stocked ? "In stock" : "Out of stock"}
          </Switch>
        </div>
      </Section>

      <Section
        title="Modal"
        note="Focus moves in on open, is trapped while open, and returns to the trigger on close."
      >
        <div className="sg-row">
          <Button onClick={() => setModalOpen(true)}>Open a dialog</Button>
        </div>
        {modalOpen && (
          <Modal title="A dialog" onClose={() => setModalOpen(false)}>
            <div className="modal-list">
              <p className="modal-note">
                Tab cycles inside this dialog. Escape closes it, and focus goes back
                to the button that opened it.
              </p>
            </div>
          </Modal>
        )}
      </Section>

      <Section title="Empty state">
        <div className="sg-frame">
          <EmptyState glyph="🍳" title="Your recipe box is empty">
            <p>Search for a dish to fill one in for you, or write your own.</p>
            <Toolbar center>
              <LinkButton to="/styleguide" variant="primary">
                A primary action
              </LinkButton>
              <LinkButton to="/styleguide">A secondary one</LinkButton>
            </Toolbar>
          </EmptyState>
        </div>
      </Section>

      {groups.map((group) => (
        <Section key={group.name} title={group.name}>
          <TokenList group={group} />
        </Section>
      ))}
    </>
  );
}
