// Importing this module registers all built-in platform presenters as a side
// effect. Import it once from the root layout so the registry is populated
// before any component calls getPresenter().
import './reddit/presenter';
import './hackernews/presenter';
import './mastodon/presenter';
