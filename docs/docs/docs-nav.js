/*
 * Sidebar + prev/next navigation for the documentation pages.
 *
 * The page list lives here so a new page only has to be added in one place.
 * Every page still carries real links in its own markup (the hub page links to
 * all of them, and the pager below renders anchors), so the set stays walkable
 * without this script.
 */
(function () {
  'use strict';

  var SECTIONS = [
    {
      label: 'Start here',
      pages: [
        { href: 'index.html', title: 'Documentation home' },
        { href: 'getting-started.html', title: 'Getting started' },
        { href: 'platforms.html', title: 'Platforms & updates' },
      ],
    },
    {
      label: 'How Frost works',
      pages: [
        { href: 'credential-refresh.html', title: 'Credential refresh' },
        { href: 'login.html', title: 'Signing in' },
        { href: 'profiles.html', title: 'Profile names' },
        { href: 'aws-config.html', title: 'The ~/.aws/config file' },
        { href: 'app-window.html', title: 'App window & tray' },
        { href: 'activity.html', title: 'Activity & logs' },
      ],
    },
    {
      label: 'Integrations',
      pages: [
        { href: 'eks.html', title: 'EKS cluster discovery' },
        { href: 'authenticator.html', title: 'Bundled IAM authenticator' },
      ],
    },
    {
      label: 'Settings',
      pages: [
        { href: 'settings.html', title: 'Settings overview' },
        { href: 'settings-login.html', title: 'Login' },
        { href: 'settings-behavior.html', title: 'Behavior' },
        { href: 'settings-privacy.html', title: 'Privacy' },
      ],
    },
    {
      label: 'Reference',
      pages: [
        { href: 'security.html', title: 'Security & privacy' },
        { href: 'files.html', title: 'Files & locations' },
        { href: 'troubleshooting.html', title: 'Troubleshooting' },
      ],
    },
  ];

  var DESKTOP = '(min-width: 901px)';

  function currentPage() {
    var name = (location.pathname.split('/').pop() || '').toLowerCase();
    return name && name !== '' ? name : 'index.html';
  }

  function flatten() {
    var all = [];
    SECTIONS.forEach(function (section) {
      section.pages.forEach(function (page) {
        all.push(page);
      });
    });
    return all;
  }

  function renderSidebar(sidebar, current) {
    var summary = document.createElement('summary');
    summary.textContent = 'All documentation';
    sidebar.appendChild(summary);

    SECTIONS.forEach(function (section) {
      var group = document.createElement('div');
      group.className = 'doc-nav-group';

      var label = document.createElement('div');
      label.className = 'doc-nav-label';
      label.textContent = section.label;
      group.appendChild(label);

      section.pages.forEach(function (page) {
        var link = document.createElement('a');
        link.href = page.href;
        link.textContent = page.title;
        if (page.href.toLowerCase() === current) {
          link.setAttribute('aria-current', 'page');
        }
        group.appendChild(link);
      });

      sidebar.appendChild(group);
    });

    // The sidebar is a <details> so it can collapse on narrow screens; on a
    // desktop width it is always open and its summary is hidden by CSS.
    var media = window.matchMedia(DESKTOP);
    var sync = function () {
      if (media.matches) sidebar.open = true;
    };
    sync();
    if (media.addEventListener) {
      media.addEventListener('change', sync);
    } else if (media.addListener) {
      media.addListener(sync);
    }
  }

  function pagerLink(page, rel) {
    var link = document.createElement('a');
    link.className = 'doc-pager-link doc-pager-' + rel;
    link.href = page.href;
    link.rel = rel;

    var label = document.createElement('small');
    label.textContent = rel === 'prev' ? '← Previous' : 'Next →';
    link.appendChild(label);

    var title = document.createElement('span');
    title.textContent = page.title;
    link.appendChild(title);

    return link;
  }

  function renderPager(pager, current) {
    var all = flatten();
    var index = -1;
    all.forEach(function (page, i) {
      if (page.href.toLowerCase() === current) index = i;
    });
    if (index < 0) return;

    if (index > 0) pager.appendChild(pagerLink(all[index - 1], 'prev'));
    if (index < all.length - 1) pager.appendChild(pagerLink(all[index + 1], 'next'));
  }

  var current = currentPage();
  var sidebar = document.getElementById('doc-nav');
  if (sidebar) renderSidebar(sidebar, current);
  var pager = document.getElementById('doc-pager');
  if (pager) renderPager(pager, current);
})();
