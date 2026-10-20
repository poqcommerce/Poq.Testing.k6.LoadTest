// Standard Poq app-start and content endpoints.

import { request, correlationFailure } from '../http.js';

export const NAMES = {
  splash: 'Splash (iOS)',
  settings: 'Settings config',
  launch: 'App launch',
  dyIdentifiers: 'Dynamic Yield identifiers',
  banners: 'Banners',
  globalBanners: 'Global banners',
  appStories: 'App stories',
  contentBlocks: 'Content blocks',
  contentCountries: 'Content data: countries',
  contentValidations: 'Content data: validations',
  contentMessages: 'Content data: messages',
  contentTitles: 'Content data: titles',
  universalLink: 'Universal link',
};

export function splash(s) {
  request(s, { key: 'splash', name: NAMES.splash, path: `/splash/ios/${s.cfg.env.appId}/3`, query: { poqUserId: s.poqUserId } });
}

// Returns the settings list (Gen-2 clients read their poq-auth salt from it).
export function settings(s, name = NAMES.settings) {
  return request(s, { key: 'settings', name, path: `/settings/config/${s.cfg.env.appId}/0` }).json;
}

export function launch(s, appVersion) {
  request(s, { key: 'launch', name: NAMES.launch, path: '/launch', query: { appVersion } });
}

// Dynamic Yield ids personalise later calls through headers. Missing ids are logged, but the journey
// continues without them — no later request path or body depends on them.
export function dynamicYieldIdentifiers(s) {
  const { json } = request(s, { key: 'dyIdentifiers', name: NAMES.dyIdentifiers, path: '/dynamicyield/identifiers' });
  if (!json || !json.userId || !json.sessionId) {
    correlationFailure(s, NAMES.dyIdentifiers, 'userId/sessionId');
    return;
  }
  s.headers['dy-user-id'] = json.userId;
  s.headers['dy-session-id'] = json.sessionId;
}

// Returns the banner list (home carousels and story ids are read from it).
export function banners(s) {
  return request(s, { key: 'banners', name: NAMES.banners, path: `/banners/${s.cfg.env.appId}` }).json;
}

// 204 = no global banners currently configured (seen on TWC prod 2026-09-28) — a valid answer.
export function globalBanners(s) {
  request(s, { key: 'globalBanners', name: NAMES.globalBanners, path: '/banners/global', expect: [200, 204] });
}

// ids: story ids from the home dynamic content, for apps that request them (omitted otherwise).
export function appStories(s, ids) {
  request(s, { key: 'appStories', name: NAMES.appStories, path: `/appstories/apps/${s.cfg.env.appId}/home`, query: { poqUserId: s.poqUserId, ids } });
}

export function contentBlocks(s) {
  request(s, { key: 'contentBlocks', name: NAMES.contentBlocks, path: `/contentBlocks/${s.cfg.env.appId}/1` });
}

export function contentData(s) {
  request(s, { key: 'contentData', name: NAMES.contentCountries, path: '/content-data/countries', checks: { 'has countries': (j) => j.countries } });
  request(s, { key: 'contentData', name: NAMES.contentValidations, path: '/content-data/validations', checks: { 'has content': (j) => j.content } });
  request(s, { key: 'contentData', name: NAMES.contentMessages, path: '/content-data/messages', checks: { 'has messages': (j) => j.messages } });
  request(s, { key: 'contentData', name: NAMES.contentTitles, path: '/content-data/titles', checks: { 'has titles': (j) => j.titles } });
}

export function universalLink(s, url) {
  request(s, { key: 'universalLink', name: NAMES.universalLink, method: 'POST', path: '/universal-links', body: { url }, data: { url } });
}
