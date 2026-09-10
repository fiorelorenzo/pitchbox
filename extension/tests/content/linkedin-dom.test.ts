// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  findPostMedia,
  readOwnProfileHandle,
  readOwnProfilePageHandle,
  readOwnProfile,
  readOwnPosts,
  getSelectorHealthReport,
  resetSelectorHealth,
  selectorHealthActivityEvents,
} from '../../src/content/shared/linkedin-dom.js';
import linkedinDomSource from '../../src/content/shared/linkedin-dom.ts?raw';

// feed.html and post-detail.html are anonymised captures of two real, signed-in
// LinkedIn pages (2026-09-03) - see extension/tests/content/fixtures/linkedin/README.md
// for what they are, what was stripped, and how to regenerate them. own-profile.html
// and own-activity.html (2026-09-07, #389/#391) are the same kind of capture for the
// signed-in member's own `/in/<slug>` page and its `recent-activity` sibling. Loaded
// with Vite's `?raw` import (not `node:fs`) because the extension's tsconfig has no
// Node type defs - it is a browser sandbox, and `pnpm -F @pitchbox/extension check`
// type-checks this test file under that same tsconfig.
import FEED_HTML from './fixtures/linkedin/feed.html?raw';
import POST_DETAIL_HTML from './fixtures/linkedin/post-detail.html?raw';
import OWN_PROFILE_HTML from './fixtures/linkedin/own-profile.html?raw';
import OWN_ACTIVITY_HTML from './fixtures/linkedin/own-activity.html?raw';

function render(html: string): void {
  document.body.innerHTML = html;
}

// Relative pushState resolves against the current (default jsdom) origin, so this
// works regardless of what that origin actually is and never trips jsdom's
// cross-origin pushState guard - same helper post-comment.test.ts already uses.
function setUrl(pathAndSearch: string): void {
  window.history.pushState({}, '', pathAndSearch);
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

  it('readPostText reads every card, falling back when a card has no commentary anchor', () => {
    // Measured on the capture (#392, live-page report plus this fixture):
    // three cards, a `feed-header-*` anchor on all three, but a
    // `commentary-*` anchor on only the first and third. The second has
    // visible body text and no commentary anchor at all, which is what
    // silently produced a null body (and `selector_health_degraded` in the
    // comment-assist panel) before the fallback below existed.
    render(FEED_HTML);
    const posts = findFeedPosts(document);
    expect(posts).toHaveLength(3);
    for (const post of posts) expect(readPostText(post, document)).toBeTruthy();
  });

  it("prefers the longest qualifying text over the first, so a commentary-less card does not return its author's headline", () => {
    // Measured live (#392): the middle card's `feed-header-*` element wraps
    // only the author's name - the headline/bio text ("Publisher and Editor
    // in Chief - Reaching 1.5 Mio Followers", 60 chars) is a *sibling*, not
    // inside it, so there is no LinkedIn-authored container to exclude it
    // by, and it precedes the real ~1238-character post body in document
    // order. "First qualifying text" picked the headline; "longest" does
    // not. own-profile.html's anonymiser preserves this: real prose over 24
    // chars is replaced by filler capped at its own original length, so the
    // real post's filler is far longer than the headline's here too.
    render(FEED_HTML);
    const [, middle] = findFeedPosts(document);
    const text = readPostText(middle, document);
    expect(text?.length).toBeGreaterThan(500);
  });

  it('the commentary anchor still wins over the fallback when it is present (no regression)', () => {
    render(FEED_HTML);
    const [first, , third] = findFeedPosts(document);
    for (const post of [first, third]) {
      const direct = [...post.querySelectorAll('[data-sdui-anchor-id^="commentary-"]')]
        .map((el) => el.textContent?.trim() ?? '')
        .filter((s) => s.length > 0)
        .join(' ');
      expect(direct.length).toBeGreaterThan(0);
      expect(readPostText(post, document)).toBe(direct);
    }
  });

  it('records the commentary-anchor miss separately from postText, so a feed with none left is visible', () => {
    render(FEED_HTML);
    for (const post of findFeedPosts(document)) readPostText(post, document);
    const report = getSelectorHealthReport();
    const commentaryAnchor = report.find(
      (e) => e.selector === 'postTextCommentaryAnchor' && e.pageKind === 'feed-sdui',
    );
    const postText = report.find((e) => e.selector === 'postText' && e.pageKind === 'feed-sdui');
    // 2 of the 3 cards carry the anchor, 1 does not - that gap is the signal
    // worth its own selector id; postText itself still comes back healthy
    // because the fallback covers the one that misses.
    expect(commentaryAnchor).toMatchObject({ matches: 2, misses: 1 });
    expect(postText).toMatchObject({ matches: 3, misses: 0 });
  });

  it('findCommentComposer finds nothing on the feed (no composer is open there)', () => {
    render(FEED_HTML);
    expect(findCommentComposer(document)).toBeNull();
  });
});

describe('readPostText: feed-sdui fallback excludes a rendered comment', () => {
  // Synthetic (module convention, same disclaimer as findCommentSubmitButton/
  // readOwnProfileHandle): feed.html's own rendered comment
  // (`comment-urn:li:comment:(...)::0`, #392) is real but only 11 characters,
  // short enough to miss `longestSubstantialText`'s 30-character floor with
  // or without the exclusion, so it cannot prove the exclusion by itself.
  // This is the same shape with a comment body long enough to actually
  // exercise it.
  it("does not return a rendered comment's text when there is no commentary anchor", () => {
    render(`
      <div role="listitem">
        <div data-sdui-anchor-id="feed-header-x">Giulia Bianchi</div>
        <div data-sdui-anchor-id="comment-urn:li:comment:(ugcPost:1,2)::0">
          <span>A rendered comment long enough on its own to pass the 30 character floor.</span>
        </div>
        <span>The post body text that should win once the comment above is excluded from the scan.</span>
      </div>
    `);
    const [post] = findFeedPosts(document);
    const text = readPostText(post, document);
    expect(text).toMatch(/post body text that should win/);
    expect(text).not.toMatch(/rendered comment/);
  });

  it('still excludes a rendered comment even when the comment is longer than the real body', () => {
    // Proves exclusion, not just length ordering: with the comment left in
    // the candidate pool, "longest wins" would pick it over the shorter but
    // real body below.
    render(`
      <div role="listitem">
        <div data-sdui-anchor-id="feed-header-x">Giulia Bianchi</div>
        <div data-sdui-anchor-id="comment-urn:li:comment:(ugcPost:1,2)::0">
          <span>A rendered comment that is deliberately much longer than the real post body below it, so a naive longest-wins scan with no exclusion would pick this instead of the actual post.</span>
        </div>
        <span>A short but real post body, over the 30 character floor.</span>
      </div>
    `);
    const [post] = findFeedPosts(document);
    const text = readPostText(post, document);
    expect(text).toMatch(/short but real post body/);
    expect(text).not.toMatch(/rendered comment/);
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
    // The classic frontend's own body container is a class
    // (`.update-components-text`) - and the fixture's anonymiser drops
    // every class name (README: "What was stripped"), so this fixture can
    // never exercise the container-preference branch of readPostText, only
    // the `longestSubstantialText` fallback below it. The container branch
    // itself is proven by the synthetic "prefers LinkedIn's own body
    // container" case further down, the same way `findCommentSubmitButton`
    // and `readOwnProfileHandle` are - see the module's own header comment.
    render(POST_DETAIL_HTML);
    const [post] = findFeedPosts(document);
    expect(post.querySelector('.update-components-text')).toBeNull();
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

describe('readOwnProfile: own-profile.html (SDUI profile frontend, real capture)', () => {
  const EXPECTED_HEADLINE =
    'We shipped the new ingest path last week and the p99 dropped by half. The interesting part was not the';

  it('reads name, handle (from the URL path), headline and about', () => {
    setUrl('/in/example-person/');
    render(OWN_PROFILE_HTML);
    const profile = readOwnProfile(document);
    expect(profile).not.toBeNull();
    expect(profile?.handle).toBe('example-person');
    expect(profile?.displayName).toBe('Giulia Bianchi');
    expect(profile?.headline).toBe(EXPECTED_HEADLINE);
    expect(profile?.about).toBeTruthy();
    // The About card's own <h2> heading ("Informazioni" - the capture is an
    // Italian UI) is a sibling of the text box this reads, never inside it -
    // if the selector regressed to reading the whole card instead of just
    // the text box, the result would start with the heading.
    expect(profile?.about?.startsWith('Informazioni')).toBe(false);
  });

  it("the handle comes from the page's own URL path, not from any link on the page", () => {
    // Every href in the anonymised capture is rewritten to
    // /in/example-person/ by the fixture scrubber (README) - if the handle
    // were read from a link instead of location.pathname, this would always
    // read back "example-person" no matter which /in/<slug> page is
    // actually open, which is exactly the case the server's persona guard
    // exists to catch (POST /api/extension/operator-profile,
    // refused: 'not_your_profile').
    setUrl('/in/a-different-slug/');
    render(OWN_PROFILE_HTML);
    expect(readOwnProfile(document)?.handle).toBe('a-different-slug');
    expect(readOwnProfilePageHandle(document)).toBe('a-different-slug');
  });

  it('never trusts the global nav for the page handle either', () => {
    // Nav names the signed-in member; the page itself may be someone else's.
    setUrl('/in/someone-else/');
    render(`<nav><a href="/in/the-operator/">Visualizza profilo</a></nav>${OWN_PROFILE_HTML}`);
    expect(readOwnProfile(document)?.handle).toBe('someone-else');
    expect(readOwnProfileHandle(document)).toBe('the-operator');
  });

  it('has no experience section - reads everything else and returns experiences as [], not a failure', () => {
    // Measured live and against a second, more thoroughly scrolled
    // recapture (2026-09-07): this account's profile renders the "no
    // experience" layout (its own sibling card is literally named
    // profileCardsBelowActivityPart1WithoutExp<slug> - see readOwnProfile's
    // own doc comment), not a selector miss. `[]` here is a tested,
    // documented outcome, not an accident.
    setUrl('/in/example-person/');
    render(OWN_PROFILE_HTML);
    const profile = readOwnProfile(document);
    expect(profile?.displayName).toBe('Giulia Bianchi');
    expect(profile?.about).toBeTruthy();
    expect(profile?.experiences).toEqual([]);
  });

  it('records a selector-health miss for experience when it comes back with no rows, even though the card exists', () => {
    // Keyed on rows read, not on the card existing, precisely so a
    // populated profile whose row selector breaks would show up here too
    // instead of looking identical to this account's legitimate empty state.
    setUrl('/in/example-person/');
    render(OWN_PROFILE_HTML);
    readOwnProfile(document);
    const report = getSelectorHealthReport();
    const experience = report.find(
      (e) => e.selector === 'ownProfileExperience' && e.pageKind === 'profile',
    );
    expect(experience?.lastResult).toBe('miss');
  });

  it('reads title, company, period and summary from experience rows when a profile has them (synthetic - this account has none, see above)', () => {
    setUrl('/in/example-person/');
    render(`
      <div id="com.linkedin.sdui.profile.card.refEXAMPLETopcard">
        <h2>Ada Lovelace</h2>
        <div>Mathematician and writer</div>
      </div>
      <div id="profileCardsExperienceOnlyexample-person">
        <ul>
          <li>
            <div>Founder</div>
            <div>Analytical Engine Co.</div>
            <div>2020 - Present</div>
            <div>Wrote the first algorithm intended for a machine.</div>
          </li>
          <li>
            <div>Research Fellow</div>
            <div>Royal Society</div>
            <div>2018 - 2020</div>
          </li>
        </ul>
      </div>
    `);
    const profile = readOwnProfile(document);
    expect(profile?.experiences).toHaveLength(2);
    expect(profile?.experiences[0]).toMatchObject({
      title: 'Founder',
      company: 'Analytical Engine Co.',
    });
    expect(profile?.experiences[1]).toMatchObject({
      title: 'Research Fellow',
      company: 'Royal Society',
    });
  });

  it('returns null when the page has no topcard at all (not a profile page)', () => {
    setUrl('/in/example-person/');
    render('<div>nothing here</div>');
    expect(readOwnProfile(document)).toBeNull();
  });
});

describe("LOR-180: the display name never comes from LinkedIn's own chrome", () => {
  it('excludes the global-nav/notification chrome from the heading scan when the topcard is missing', () => {
    // Reproduces the bug report exactly: own-profile.html's own doc comment
    // above already records the topcard selector missing five times in a
    // row on a real profile visit, which is what makes step two (the
    // page-wide h1/h2 scan) reachable at all. Before the fix, that scan had
    // no chrome exclusion, so the first heading in document order won even
    // when it was LinkedIn's own Italian notification-count badge - "0
    // notifiche in totale" is 21 characters with no sentence punctuation,
    // so it passed the same length/punctuation filter a real name does.
    const brokenTopcard = OWN_PROFILE_HTML.replace(
      'com.linkedin.sdui.profile.card.refEXAMPLEMEMBERTopcard',
      'com.linkedin.sdui.profile.card.refEXAMPLEMEMBERTopcardBroken',
    );
    expect(brokenTopcard).not.toBe(OWN_PROFILE_HTML);
    setUrl('/in/example-person/');
    render(`<header role="banner"><h2>0 notifiche in totale</h2></header>${brokenTopcard}`);

    const capture = readOwnProfile(document);
    expect(capture?.displayName).toBe('Giulia Bianchi');

    const heading = getSelectorHealthReport().find(
      (e) => e.selector === 'ownProfileNameHeading' && e.pageKind === 'profile',
    );
    expect(heading?.lastResult).toBe('match');
  });

  it('strips a leading unread-notification count from the document-title fallback', () => {
    // LinkedIn writes the tab title as "(3) <name> | LinkedIn" once there is
    // an unread count - split('|')[0] alone keeps the "(3) " prefix.
    setUrl('/in/example-person/');
    document.title = '(3) Giulia Bianchi | LinkedIn';
    render('<main><section><p>no headings anywhere in this render</p></section></main>');

    const capture = readOwnProfile(document);
    expect(capture?.displayName).toBe('Giulia Bianchi');

    const title = getSelectorHealthReport().find(
      (e) => e.selector === 'ownProfileNameTitle' && e.pageKind === 'profile',
    );
    expect(title?.lastResult).toBe('match');
  });

  it('answers from the topcard alone on the intact capture, and never touches the heading/title sources', () => {
    setUrl('/in/example-person/');
    render(OWN_PROFILE_HTML);
    readOwnProfile(document);

    const report = getSelectorHealthReport();
    const topcard = report.find(
      (e) => e.selector === 'ownProfileNameTopcard' && e.pageKind === 'profile',
    );
    expect(topcard?.lastResult).toBe('match');
    expect(report.find((e) => e.selector === 'ownProfileNameHeading')).toBeUndefined();
    expect(report.find((e) => e.selector === 'ownProfileNameTitle')).toBeUndefined();
  });
});

describe('selector health: red on a broken profile selector, green on the intact capture', () => {
  it('reports the topcard as the miss, and still captures what does not need it (#448)', () => {
    // Lorenzo's own profile rendered a shape where this selector found
    // nothing, five rescans in a row, and the capture returned null - so
    // `operator_profiles` stayed empty over one missing container. The
    // topcard is now tracked on its own and only the headline depends on it.
    const broken = OWN_PROFILE_HTML.replace(
      'com.linkedin.sdui.profile.card.refEXAMPLEMEMBERTopcard',
      'com.linkedin.sdui.profile.card.refEXAMPLEMEMBERTopcardBroken',
    );
    expect(broken).not.toBe(OWN_PROFILE_HTML);
    setUrl('/in/example-person/');
    render(broken);

    const capture = readOwnProfile(document);
    expect(capture).not.toBeNull();
    expect(capture!.displayName).toBeTruthy();
    expect(capture!.headline).toBeNull();

    const report = getSelectorHealthReport();
    const topcard = report.find(
      (e) => e.selector === 'ownProfileTopcard' && e.pageKind === 'profile',
    );
    const name = report.find((e) => e.selector === 'ownProfileName' && e.pageKind === 'profile');
    expect(topcard?.lastResult).toBe('miss');
    expect(name?.lastResult).toBe('match');
  });

  it('falls back to the document title when no heading names the member', () => {
    setUrl('/in/example-person/');
    document.title = 'Giulia Bianchi | LinkedIn';
    render('<main><section><p>no headings anywhere in this render</p></section></main>');

    const capture = readOwnProfile(document);
    expect(capture?.displayName).toBe('Giulia Bianchi');
  });

  it('is green again for name against the unmodified capture', () => {
    setUrl('/in/example-person/');
    render(OWN_PROFILE_HTML);
    expect(readOwnProfile(document)).not.toBeNull();
    const name = getSelectorHealthReport().find(
      (e) => e.selector === 'ownProfileName' && e.pageKind === 'profile',
    );
    expect(name?.lastResult).toBe('match');
  });

  it("goes red when the About card's text-box instrumentation is missing", () => {
    const broken = OWN_PROFILE_HTML.replace(/data-testid="expandable-text-box"/, '');
    expect(broken).not.toBe(OWN_PROFILE_HTML);
    setUrl('/in/example-person/');
    render(broken);
    expect(readOwnProfile(document)?.about).toBeNull();
    const about = getSelectorHealthReport().find(
      (e) => e.selector === 'ownProfileAbout' && e.pageKind === 'profile',
    );
    expect(about?.lastResult).toBe('miss');
  });

  it('is green again for about against the unmodified capture', () => {
    setUrl('/in/example-person/');
    render(OWN_PROFILE_HTML);
    expect(readOwnProfile(document)?.about).toBeTruthy();
    const about = getSelectorHealthReport().find(
      (e) => e.selector === 'ownProfileAbout' && e.pageKind === 'profile',
    );
    expect(about?.lastResult).toBe('match');
  });
});

describe('readOwnPosts: own-activity.html (classic frontend, real capture)', () => {
  it('reads every activity card, each with a distinct urn and non-empty text', () => {
    setUrl('/in/example-person/recent-activity/all/');
    render(OWN_ACTIVITY_HTML);
    const posts = readOwnPosts(document);
    expect(posts).toHaveLength(6);
    // The property that actually matters for dedupe
    // (operator_voice_samples is keyed on (organization, external_id)):
    // six distinct urns, not six copies of the same one.
    expect(new Set(posts.map((p) => p.externalId)).size).toBe(6);
    for (const post of posts) {
      expect(post.externalId).toMatch(/^urn:li:activity:\d+$/);
      expect(post.text.length).toBeGreaterThan(0);
    }
  });

  it("reads each post's own relative-time text, never a machine timestamp", () => {
    setUrl('/in/example-person/recent-activity/all/');
    render(OWN_ACTIVITY_HTML);
    for (const post of readOwnPosts(document)) expect(post.relativeTime).toMatch(/\d/);
  });
});

describe('readOwnPosts: synthetic markup', () => {
  it('reads the recent-activity list via the same classic-frontend post accessors', () => {
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
      {
        externalId: 'urn:li:activity:1111',
        text: 'First post about the analytical engine.',
        relativeTime: null,
      },
      {
        externalId: 'urn:li:activity:2222',
        text: 'Second post about punched cards.',
        relativeTime: null,
      },
    ]);
  });

  it('skips a feed-sdui sighting: no stable urn to dedupe a voice sample on', () => {
    render(`
      <div role="listitem">
        <div data-sdui-anchor-id="feed-header-1">Ada Lovelace</div>
        <div data-sdui-anchor-id="commentary-1">A feed post with no stable identifier.</div>
      </div>
    `);
    expect(readOwnPosts(document)).toEqual([]);
  });
});

describe('findPostMedia (#569): synthetic markup', () => {
  // Neither fixture contains a post with attached media (see
  // fixtures/linkedin/README.md: images become empty `<img>` slots and the
  // only ones either real capture actually has are profile avatars) - same
  // disclaimer as `findCommentSubmitButton`/`findPostComposer` above, and
  // the module's own doc comment on `findPostMedia` names it explicitly.
  function stubRect(el: Element, width: number, height: number, onScreen = true): void {
    const left = onScreen ? 0 : -9999;
    const top = onScreen ? 0 : -9999;
    const rect = {
      top,
      left,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
    };
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ ...rect, toJSON: () => rect });
  }

  beforeEach(() => {
    vi.stubGlobal('innerWidth', 1000);
    vi.stubGlobal('innerHeight', 800);
  });

  it('finds a substantial image and excludes the author avatar wrapped in a profile link', () => {
    render(`
      <div role="article" data-urn="urn:li:activity:7000000000000000001">
        <a href="/in/example-person/"><img id="avatar" /></a>
        <img id="media" alt="A chart showing quarterly growth" />
      </div>
    `);
    const [post] = findFeedPosts(document);
    stubRect(document.getElementById('avatar')!, 48, 48);
    stubRect(document.getElementById('media')!, 400, 300);
    const media = findPostMedia(post);
    expect(media?.element.id).toBe('media');
    expect(media?.kind).toBe('image');
    expect(media?.alt).toBe('A chart showing quarterly growth');
    expect(media?.partial).toBe(false);
  });

  it('returns null when the only substantial-sized element is the avatar', () => {
    render(`
      <div role="article" data-urn="urn:li:activity:7000000000000000001">
        <a href="/in/example-person/"><img id="avatar" /></a>
      </div>
    `);
    const [post] = findFeedPosts(document);
    stubRect(document.getElementById('avatar')!, 400, 400);
    expect(findPostMedia(post)).toBeNull();
  });

  it('excludes an image below the minimum rendered size (a reaction icon, not the post media)', () => {
    render(`
      <div role="article" data-urn="urn:li:activity:7000000000000000001">
        <img id="icon" />
      </div>
    `);
    const [post] = findFeedPosts(document);
    stubRect(document.getElementById('icon')!, 24, 24);
    expect(findPostMedia(post)).toBeNull();
  });

  it('reports a video element as video_frame, never as a plain image', () => {
    render(`
      <div role="article" data-urn="urn:li:activity:7000000000000000001">
        <video id="clip"></video>
      </div>
    `);
    const [post] = findFeedPosts(document);
    stubRect(document.getElementById('clip')!, 400, 300);
    expect(findPostMedia(post)?.kind).toBe('video_frame');
  });

  it('reports more than one substantial image as a carousel page, and picks the one on screen', () => {
    render(`
      <div role="article" data-urn="urn:li:activity:7000000000000000001">
        <img id="onscreen" alt="page one" />
        <img id="offscreen" alt="page two" />
      </div>
    `);
    const [post] = findFeedPosts(document);
    stubRect(document.getElementById('onscreen')!, 400, 300, true);
    stubRect(document.getElementById('offscreen')!, 400, 300, false);
    const media = findPostMedia(post);
    expect(media?.kind).toBe('carousel_page');
    expect(media?.partial).toBe(true);
    expect(media?.element.id).toBe('onscreen');
  });

  it('falls back to an off-screen candidate when nothing intersects the viewport, so alt is still readable', () => {
    render(`
      <div role="article" data-urn="urn:li:activity:7000000000000000001">
        <img id="scrolled-away" alt="scrolled out of view" />
      </div>
    `);
    const [post] = findFeedPosts(document);
    stubRect(document.getElementById('scrolled-away')!, 400, 300, false);
    const media = findPostMedia(post);
    expect(media?.element.id).toBe('scrolled-away');
    expect(media?.alt).toBe('scrolled out of view');
  });

  it('records selector health for postMedia against a classic post-detail page', () => {
    render(`
      <div role="article" data-urn="urn:li:activity:7000000000000000001">
        <img id="media" />
      </div>
    `);
    const [post] = findFeedPosts(document);
    stubRect(document.getElementById('media')!, 400, 300);
    findPostMedia(post);
    const entry = getSelectorHealthReport().find(
      (e) => e.selector === 'postMedia' && e.pageKind === 'post-detail-classic',
    );
    expect(entry?.lastResult).toBe('match');
  });
});
