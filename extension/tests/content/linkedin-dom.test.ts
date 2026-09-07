// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectPageKind,
  findFeedPosts,
  readPostIdentifier,
  readPostAuthor,
  readPostText,
  findCommentComposer,
  findCommentSubmitButton,
  findPostComposer,
  findPostComposerModal,
  findPostSubmitButton,
  readOwnProfileHandle,
  readOwnProfile,
  readOwnPosts,
  getSelectorHealthReport,
  resetSelectorHealth,
  selectorHealthActivityEvents,
} from '../../src/content/shared/linkedin-dom.js';
import linkedinDomSource from '../../src/content/shared/linkedin-dom.ts?raw';

// feed.html and post-detail.html are anonymised captures of two real, signed-in
// LinkedIn pages (2026-09-03) - see extension/tests/content/fixtures/linkedin/README.md
// for what they are, what was stripped, and how to regenerate them. Loaded with
// Vite's `?raw` import (not `node:fs`) because the extension's tsconfig has no
// Node type defs - it is a browser sandbox, and `pnpm -F @pitchbox/extension check`
// type-checks this test file under that same tsconfig.
import FEED_HTML from './fixtures/linkedin/feed.html?raw';
import POST_DETAIL_HTML from './fixtures/linkedin/post-detail.html?raw';

function render(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetSelectorHealth();
});

describe('feed.html (SDUI frontend, real capture)', () => {
  it('detects the sdui feed page kind', () => {
    render(FEED_HTML);
    expect(detectPageKind(document)).toBe('feed-sdui');
  });

  it('findFeedPosts finds every post card that carries a header anchor', () => {
    render(FEED_HTML);
    const posts = findFeedPosts(document);
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(post.getAttribute('role')).toBe('listitem');
  });

  it('readPostIdentifier reports a render-anchor, never a urn, for a feed post', () => {
    render(FEED_HTML);
    const posts = findFeedPosts(document);
    for (const post of posts) {
      const id = readPostIdentifier(post, document);
      expect(id.frontend).toBe('feed-sdui');
      expect(id.kind).toBe('render-anchor');
      expect(id.value).toMatch(/^feed-header-/);
      // The whole point of #303: this token is a render address, not an
      // activity id - it must never be shaped like one.
      expect(id.value).not.toMatch(/^urn:li:/);
    }
  });

  it('readPostAuthor reads the display name and vanity handle for every found post', () => {
    render(FEED_HTML);
    const posts = findFeedPosts(document);
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      const author = readPostAuthor(post, document);
      expect(author.name).toBeTruthy();
      expect(author.handle).toBe('example-person');
    }
  });

  it('readPostText reads at least one commentary block for a post that has one', () => {
    render(FEED_HTML);
    const posts = findFeedPosts(document);
    const texts = posts.map((post) => readPostText(post, document));
    expect(texts.some((t) => typeof t === 'string' && t.length > 0)).toBe(true);
  });

  it('findCommentComposer finds nothing on the feed (no composer is open there)', () => {
    render(FEED_HTML);
    expect(findCommentComposer(document)).toBeNull();
  });
});

describe('post-detail.html (classic Ember frontend, real capture)', () => {
  it('detects the classic post-detail page kind', () => {
    render(POST_DETAIL_HTML);
    expect(detectPageKind(document)).toBe('post-detail-classic');
  });

  it('findFeedPosts finds exactly the one post the human opened', () => {
    render(POST_DETAIL_HTML);
    const posts = findFeedPosts(document);
    expect(posts).toHaveLength(1);
    expect(posts[0].getAttribute('role')).toBe('article');
  });

  it('readPostIdentifier reads the real activity urn', () => {
    render(POST_DETAIL_HTML);
    const [post] = findFeedPosts(document);
    const id = readPostIdentifier(post, document);
    expect(id).toEqual({
      frontend: 'post-detail-classic',
      kind: 'urn',
      value: 'urn:li:activity:7000000000000000001',
    });
  });

  it('readPostAuthor reads the byline name and vanity handle, not a comment author', () => {
    render(POST_DETAIL_HTML);
    const [post] = findFeedPosts(document);
    const author = readPostAuthor(post, document);
    expect(author.name).toBe('Giulia Bianchi');
    expect(author.handle).toBe('example-person');
  });

  it('readPostText finds the post body and excludes comment text', () => {
    render(POST_DETAIL_HTML);
    const [post] = findFeedPosts(document);
    const text = readPostText(post, document);
    expect(text).toBeTruthy();
    expect(text).toMatch(/ingest path/);
  });

  it('findCommentComposer finds the real contenteditable comment box', () => {
    render(POST_DETAIL_HTML);
    const composer = findCommentComposer(document);
    expect(composer).not.toBeNull();
    expect(composer?.getAttribute('contenteditable')).toBe('true');
    expect(composer?.getAttribute('role')).toBe('textbox');
  });

  it('findCommentSubmitButton correctly finds nothing on an untyped composer', () => {
    // Real, measured LinkedIn behaviour, not a selector break: LinkedIn does
    // not render a submit control for a comment box with nothing typed into
    // it. See the doc comment on findCommentSubmitButton.
    render(POST_DETAIL_HTML);
    expect(findCommentSubmitButton(document)).toBeNull();
  });

  it('readOwnProfileHandle finds nothing (the global nav sits outside the captured root)', () => {
    render(POST_DETAIL_HTML);
    expect(readOwnProfileHandle(document)).toBeNull();
  });

  // #379, measured on a real signed-in `/posts/...` page: the first element
  // with 30+ characters of its own text was a clipped, screen-reader-only
  // line ("35 minuti fa - Visibile a tutti su LinkedIn e altrove"), so the
  // suggestion request carried LinkedIn's visibility metadata instead of the
  // post. Both shapes below are what that page actually contains.
  it('readPostText skips a screen-reader-only line that precedes the body', () => {
    render(`
      <div role="article" data-urn="urn:li:activity:7000000000000000002" data-view-name="post">
        <span class="visually-hidden">35 minuti fa • Visibile a tutti su LinkedIn e altrove</span>
        <span>We are letting AI agents handle more of the outreach work behind the product.</span>
      </div>`);
    const [post] = findFeedPosts(document);
    expect(readPostText(post, document)).toMatch(/AI agents handle more/);
  });

  it("readPostText prefers LinkedIn's own body container when it is present", () => {
    render(`
      <div role="article" data-urn="urn:li:activity:7000000000000000003" data-view-name="post">
        <span class="a11y-text">2 ore fa • Visibile a tutti</span>
        <div class="update-components-text">The workflow runs on a queue and a human approves every message.</div>
        <div data-id="comment:1"><span>A commenter saying something long enough to qualify.</span></div>
      </div>`);
    const [post] = findFeedPosts(document);
    const text = readPostText(post, document);
    expect(text).toMatch(/runs on a queue/);
    expect(text).not.toMatch(/commenter/);
  });
});

describe('selector health: matches expected structure on both real captures', () => {
  it('records a match for every accessor that found something, keyed by page kind', () => {
    render(POST_DETAIL_HTML);
    const [post] = findFeedPosts(document);
    readPostIdentifier(post, document);
    readPostAuthor(post, document);
    readPostText(post, document);
    findCommentComposer(document);

    const report = getSelectorHealthReport();
    const byKey = new Map(report.map((e) => [`${e.selector}:${e.pageKind}`, e]));
    for (const selector of [
      'feedPost',
      'postIdentifier',
      'postAuthor',
      'postText',
      'commentComposer',
    ]) {
      const entry = byKey.get(`${selector}:post-detail-classic`);
      expect(entry, `expected a health entry for ${selector}`).toBeDefined();
      expect(entry?.lastResult).toBe('match');
      expect(entry?.misses).toBe(0);
    }
  });
});

describe('selector health: red on a broken selector, green on the intact fixture', () => {
  // A test whose fixture cannot fail is not a test: this proves the health
  // report actually goes red by deliberately breaking the exact attribute
  // findCommentComposer depends on, on a clone of the real capture, then
  // shows the same check is green again against the unmodified capture.
  it('goes red when the composer attribute LinkedIn would normally render is missing', () => {
    const broken = POST_DETAIL_HTML.replace(
      '<div contenteditable="true" aria-label="Editor di testo per la creazione di contenuti" role="textbox">',
      '<div aria-label="Editor di testo per la creazione di contenuti">',
    );
    expect(broken).not.toBe(POST_DETAIL_HTML);

    render(broken);
    expect(findCommentComposer(document)).toBeNull();

    const report = getSelectorHealthReport();
    const entry = report.find(
      (e) => e.selector === 'commentComposer' && e.pageKind === 'post-detail-classic',
    );
    expect(entry?.lastResult).toBe('miss');
    expect(entry?.misses).toBe(1);

    const events = selectorHealthActivityEvents(report);
    expect(events).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        source: 'linkedin-dom',
        message: 'activity.linkedin-dom.selector-miss',
        messageParams: expect.objectContaining({
          selector: 'commentComposer',
          pageKind: 'post-detail-classic',
        }),
      }),
    );
  });

  it('is green again against the unmodified, intact capture', () => {
    render(POST_DETAIL_HTML);
    expect(findCommentComposer(document)).not.toBeNull();

    const report = getSelectorHealthReport();
    const entry = report.find(
      (e) => e.selector === 'commentComposer' && e.pageKind === 'post-detail-classic',
    );
    expect(entry?.lastResult).toBe('match');
    expect(entry?.misses).toBe(0);
    expect(selectorHealthActivityEvents(report)).toHaveLength(0);
  });
});

describe('synthetic markup: affordances neither real capture rendered', () => {
  // Neither fixture shows a typed comment box, an open post-composer modal,
  // or the global identity nav (all outside what was captured - see the
  // module's header comment). These build the minimal shape each depends on,
  // the same way reddit-dom.test.ts's shadow-DOM cases do for markup no
  // browser here could capture live.

  it('findCommentSubmitButton finds a real button[type="submit"] once one exists', () => {
    render(
      '<div role="textbox" contenteditable="true">a draft</div><button type="submit">Commenta</button>',
    );
    const button = findCommentSubmitButton(document);
    expect(button).toBeInstanceOf(HTMLButtonElement);
  });

  it('findPostComposer finds the same contenteditable/textbox shape inside an open modal', () => {
    render(
      '<div role="dialog"><div contenteditable="true" role="textbox">Cosa vuoi condividere?</div></div>',
    );
    const composer = findPostComposer(document);
    expect(composer).not.toBeNull();
    expect(composer?.getAttribute('role')).toBe('textbox');
  });

  it('findPostComposerModal finds the role="dialog" container the post composer opens in', () => {
    render(
      '<div role="dialog"><div contenteditable="true" role="textbox">Cosa vuoi condividere?</div></div>',
    );
    const modal = findPostComposerModal(document);
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute('role')).toBe('dialog');
  });

  it('findPostComposerModal does not mistake an inline comment composer (no dialog ancestor) for the post modal', () => {
    render('<div contenteditable="true" role="textbox">a comment draft</div>');
    expect(findPostComposerModal(document)).toBeNull();
  });

  it('findPostSubmitButton, scoped to the modal, finds the submit control once one exists', () => {
    render(
      '<div role="dialog"><div contenteditable="true" role="textbox">a draft post</div><button type="submit">Pubblica</button></div>',
    );
    const modal = findPostComposerModal(document)!;
    const button = findPostSubmitButton(modal);
    expect(button).toBeInstanceOf(HTMLButtonElement);
  });

  it('findPostSubmitButton scoped to the modal ignores a submit button outside it', () => {
    render(
      '<div role="dialog"><div contenteditable="true" role="textbox">a draft post</div></div>' +
        '<button type="submit">Commenta</button>',
    );
    const modal = findPostComposerModal(document)!;
    expect(findPostSubmitButton(modal)).toBeNull();
  });

  it("readOwnProfileHandle reads the member's own profile link out of the global nav", () => {
    render('<nav><a href="/in/own-handle/">Visualizza profilo</a></nav><main></main>');
    expect(readOwnProfileHandle(document)).toBe('own-handle');
  });

  it('readOwnProfileHandle returns null when there is no nav at all (matches both real captures)', () => {
    render('<main><div>no identity nav here</div></main>');
    expect(readOwnProfileHandle(document)).toBeNull();
  });
});

describe('compliance boundary: this module reads the DOM and nothing else', () => {
  // #303's scope is the DOM module only; #308 generalises this check across
  // extension/src/ in CI. This local assertion just proves linkedin-dom.ts
  // itself never crosses the line docs/linkedin-integration-design.md draws:
  // no request toward linkedin.com, no cookie or storage read, no synthetic
  // interaction.
  const source = linkedinDomSource;

  it('never calls fetch or XMLHttpRequest', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest/);
  });

  it('never reads cookies or localStorage/sessionStorage', () => {
    expect(source).not.toMatch(/document\.cookie/);
    expect(source).not.toMatch(/localStorage/);
    expect(source).not.toMatch(/sessionStorage/);
  });

  it('never dispatches a synthetic click or submit', () => {
    expect(source).not.toMatch(/\.click\s*\(/);
    expect(source).not.toMatch(/dispatchEvent/);
    expect(source).not.toMatch(/\.submit\s*\(/);
  });

  it('never uses a chrome extension API to send or read anything', () => {
    expect(source).not.toMatch(/chrome\.(runtime|storage|cookies|tabs|scripting)\b/);
  });
});

describe('readOwnProfile / readOwnPosts: persona capture (LI-21)', () => {
  // No real profile-page fixture exists yet (see the module's own doc
  // comment on readOwnProfile) - this is a hand-built DOM that mirrors the
  // structure the reader targets: a `<main><h1>` top card with a headline
  // line, an `id="about"` section, and an `id="experience"` section of
  // `<li>` entries read positionally.
  function renderProfile(opts: { canonicalHref?: string; ogUrl?: string; body: string }): void {
    document.head.innerHTML = [
      opts.canonicalHref ? `<link rel="canonical" href="${opts.canonicalHref}">` : '',
      opts.ogUrl ? `<meta property="og:url" content="${opts.ogUrl}">` : '',
    ].join('');
    document.body.innerHTML = opts.body;
  }

  const PROFILE_BODY = `
    <main>
      <section>
        <h1>Ada Lovelace</h1>
        <div>Mathematician and writer</div>
      </section>
    </main>
    <section id="about">
      <h2>Informazioni</h2>
      <div>I write about the analytical engine and what a general-purpose computer could someday do.</div>
    </section>
    <section id="experience">
      <h2>Esperienza</h2>
      <ul>
        <li>
          <div>Founder</div>
          <div>Analytical Engine Co.</div>
          <div>2020 - Present</div>
          <div>Wrote the first algorithm intended for a machine, published as notes on Menabrea's memoir.</div>
        </li>
      </ul>
    </section>
  `;

  it('reads name, handle (from the canonical link, not nav), headline, about and experience', () => {
    renderProfile({
      canonicalHref: 'https://www.linkedin.com/in/ada-lovelace/',
      body: PROFILE_BODY,
    });
    const profile = readOwnProfile(document);
    expect(profile).not.toBeNull();
    expect(profile?.handle).toBe('ada-lovelace');
    expect(profile?.displayName).toBe('Ada Lovelace');
    expect(profile?.headline).toBe('Mathematician and writer');
    expect(profile?.about).toMatch(/analytical engine/);
    expect(profile?.experiences).toEqual([
      {
        title: 'Founder',
        company: 'Analytical Engine Co.',
        period: '2020 - Present',
        summary:
          "Wrote the first algorithm intended for a machine, published as notes on Menabrea's memoir.",
      },
    ]);
  });

  it('never trusts the global nav for the page handle, only the canonical URL', () => {
    // Nav names the signed-in member; the page itself is someone else's -
    // this is exactly the "visited a competitor's profile" case the server
    // guard (POST /api/extension/operator-profile) has to refuse.
    renderProfile({
      canonicalHref: 'https://www.linkedin.com/in/someone-else/',
      body: `<nav><a href="/in/the-operator/">Visualizza profilo</a></nav>${PROFILE_BODY}`,
    });
    expect(readOwnProfile(document)?.handle).toBe('someone-else');
    expect(readOwnProfileHandle(document)).toBe('the-operator');
  });

  it('falls back to og:url when there is no canonical link', () => {
    renderProfile({ ogUrl: 'https://www.linkedin.com/in/og-fallback/', body: PROFILE_BODY });
    expect(readOwnProfile(document)?.handle).toBe('og-fallback');
  });

  it('returns null when the page has no top card at all (not a profile page)', () => {
    renderProfile({ body: '<main><div>nothing here</div></main>' });
    expect(readOwnProfile(document)).toBeNull();
  });

  it('returns about/experience as null/empty when those sections are absent, without failing the whole read', () => {
    renderProfile({
      canonicalHref: 'https://www.linkedin.com/in/minimal/',
      body: '<main><section><h1>Minimal Person</h1><div>Just a headline</div></section></main>',
    });
    const profile = readOwnProfile(document);
    expect(profile?.displayName).toBe('Minimal Person');
    expect(profile?.about).toBeNull();
    expect(profile?.experiences).toEqual([]);
  });

  it('records selector-health misses for the about/experience sections when absent', () => {
    renderProfile({
      canonicalHref: 'https://www.linkedin.com/in/minimal/',
      body: '<main><section><h1>Minimal Person</h1></section></main>',
    });
    readOwnProfile(document);
    const report = getSelectorHealthReport();
    const about = report.find((e) => e.selector === 'ownProfileAbout' && e.pageKind === 'profile');
    const experience = report.find(
      (e) => e.selector === 'ownProfileExperience' && e.pageKind === 'profile',
    );
    expect(about?.lastResult).toBe('miss');
    expect(experience?.lastResult).toBe('miss');
  });

  it('readOwnPosts reads the recent-activity list via the same classic-frontend post accessors', () => {
    // Same shape post-detail.html's own classic-frontend posts use
    // (role="article" + data-urn), reused here rather than invented, per
    // "Two frontends, one identifier".
    render(`
      <div role="article" data-urn="urn:li:activity:1111">
        <div class="update-components-text">First post about the analytical engine.</div>
      </div>
      <div role="article" data-urn="urn:li:activity:2222">
        <div class="update-components-text">Second post about punched cards.</div>
      </div>
    `);
    const posts = readOwnPosts(document);
    expect(posts).toEqual([
      { externalId: 'urn:li:activity:1111', text: 'First post about the analytical engine.' },
      { externalId: 'urn:li:activity:2222', text: 'Second post about punched cards.' },
    ]);
  });

  it('readOwnPosts skips a feed-sdui sighting: no stable urn to dedupe a voice sample on', () => {
    render(`
      <div role="listitem">
        <div data-sdui-anchor-id="feed-header-1">Ada Lovelace</div>
        <div data-sdui-anchor-id="commentary-1">A feed post with no stable identifier.</div>
      </div>
    `);
    expect(readOwnPosts(document)).toEqual([]);
  });
});
