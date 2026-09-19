/**
 * main.js
 *
 * WHAT THIS ACTOR DOES
 *
 * It finds Kickstarter creators whose project has not reached its funding
 * goal, either still live and raising, or already ended as failed, and
 * collects a publicly published contact address for each one.
 *
 * Three sources, none of them behind any login or challenge:
 *   1. Kickstarter's own public search endpoint, for the project list and
 *      the funding numbers.
 *   2. The project's own public page, for the full story text and the
 *      creator's short biography and any linked website.
 *   3. The creator's own website, crawled the same way the YouTube tool
 *      crawls a channel's linked site.
 *
 * WHAT COUNTS AS UNDERFUNDED
 *
 * A project is kept only when pledged is strictly less than goal, checked
 * on our own side after the search results come back, since a live project
 * can already be sitting above its goal while Kickstarter still lists it as
 * live. Both live and failed states are searched; successful projects are
 * never requested at all.
 */

import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import { extractEmails, extractUrls, rankEmails } from './emailFinder.js';
import { discoverProjects, fetchProjectPage, splitLinks } from './kickstarter.js';

await Actor.init();

const input = (await Actor.getInput()) || {};

const {
    categoryId,
    states = ['live', 'failed'],
    sort = 'newest',
    maxPagesPerState = 200,
    maxProjects = 0,
    crawlCreatorSites = true,
    maxPagesPerSite = 6,
    minimumScore = 0,
    useApifyProxy = true,
    requestDelayMs = 1500,
} = input;

if (!categoryId) {
    throw new Error('No categoryId supplied. Design is 7, Film and Video is 10, Games is 12, Technology is 16.');
}

const proxyConfiguration = useApifyProxy ? await Actor.createProxyConfiguration() : undefined;
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : null;

/* ================================================================== */
/* STEP 1. Discover, one state at a time, then keep only underfunded.  */
/* ================================================================== */

const store = await Actor.openKeyValueStore('KICKSTARTER-CONTACT-FINDER-STATE', { forceCloud: true });
const stateKey = `CATEGORY-${categoryId}`;
const savedState = (await store.getValue(stateKey)) || { seenProjectIds: [] };
const seenProjectIds = new Set(savedState.seenProjectIds || []);

const underfunded = [];

for (const state of states) {
    log.info(`Searching category ${categoryId}, state ${state}.`);
    const projects = await discoverProjects({ categoryId, state, sort, maxPages: maxPagesPerState, proxyUrl });
    log.info(`State ${state} returned ${projects.length} projects before any filtering.`);

    for (const p of projects) {
        if (seenProjectIds.has(p.id)) continue;
        if (!(p.pledged < p.goal)) continue;

        seenProjectIds.add(p.id);
        underfunded.push(p);

        if (maxProjects > 0 && underfunded.length >= maxProjects) break;
    }

    await store.setValue(stateKey, { seenProjectIds: [...seenProjectIds] });
    if (maxProjects > 0 && underfunded.length >= maxProjects) break;
}

log.info(`${underfunded.length} new underfunded projects to process this run.`);

if (underfunded.length === 0) {
    log.info('Nothing new found. Either everything in range has already been processed in an earlier run, or this category and state combination is genuinely exhausted.');
    await Actor.exit();
}

/* ================================================================== */
/* STEP 2. Read each project's own page and gather candidate emails.  */
/* ================================================================== */

const results = new Map();
const siteQueue = [];

for (const project of underfunded) {
    const projectUrl = project?.urls?.web?.project;
    const creatorUrl = project?.creator?.urls?.web?.user;
    if (!projectUrl) continue;

    const { storyText, links } = await fetchProjectPage(projectUrl, proxyUrl);
    await sleep(requestDelayMs);

    const hits = [
        ...extractEmails(storyText, { source: 'projectStory', sourceUrl: projectUrl }),
    ];

    const allLinks = [...new Set([...links, ...extractUrls(storyText)])];
    const { ownSites, socialProfiles } = splitLinks(allLinks);

    results.set(project.id, {
        projectId: project.id,
        projectName: project.name,
        projectUrl,
        blurb: project.blurb,
        goal: project.goal,
        pledged: project.pledged,
        currency: project.currency,
        state: project.state,
        country: project.country,
        location: project?.location?.displayable_name || null,
        creatorName: project?.creator?.name || null,
        creatorUrl,
        linkedSites: ownSites,
        socialProfiles,
        rawHits: hits,
        pagesChecked: [projectUrl],
    });

    if (crawlCreatorSites) {
        for (const site of ownSites.slice(0, 2)) {
            siteQueue.push({ url: site, userData: { projectId: project.id, depth: 0 } });
        }
    }
}

/* ================================================================== */
/* STEP 3. Crawl each creator's own website for a contact page.       */
/* ================================================================== */

const CONTACT_LINK_WORDS = [
    'contact', 'about', 'team', 'press', 'media', 'work with', 'hire',
    'impressum', 'kontakt', 'connect', 'support', 'help', 'inquiries',
    'partnership', 'sponsor', 'advertise', 'collab',
];

const pagesSpent = new Map();

if (crawlCreatorSites && siteQueue.length > 0) {
    log.info(`Crawling ${siteQueue.length} creator websites for contact pages.`);

    const crawler = new CheerioCrawler({
        proxyConfiguration,
        maxConcurrency: 5,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 45,
        failedRequestHandler: async ({ request }) => {
            log.debug(`Gave up on ${request.url}`);
        },

        async requestHandler({ request, $, enqueueLinks, body }) {
            const { projectId, depth } = request.userData;
            const record = results.get(projectId);
            if (!record) return;

            const origin = safeOrigin(request.url);
            const spent = pagesSpent.get(origin) || 0;
            if (spent >= maxPagesPerSite) return;
            pagesSpent.set(origin, spent + 1);

            const isContactPage = /contact|about|team|press|impressum|kontakt|connect/i.test(request.url);
            const source = isContactPage ? 'contactPage' : 'siteBody';

            const text = $('body').text().replace(/\s+/g, ' ');
            record.rawHits.push(...extractEmails(text, { source, sourceUrl: request.url }));

            $('a[href^="mailto:"]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const address = href.replace(/^mailto:/i, '').split('?')[0];
                record.rawHits.push(...extractEmails(address, { source: 'mailtoLink', sourceUrl: request.url }));
            });

            const rawHtml = typeof body === 'string' ? body : body?.toString?.('utf8') || '';
            record.rawHits.push(...extractEmails(rawHtml.slice(0, 400000), { source: 'siteBody', sourceUrl: request.url }));

            record.pagesChecked.push(request.url);

            if (depth === 0) {
                const candidates = [];
                $('a[href]').each((_, el) => {
                    const href = $(el).attr('href');
                    const label = ($(el).text() || '').toLowerCase().trim();
                    if (!href) return;

                    const looksRight = CONTACT_LINK_WORDS.some((w) => label.includes(w) || href.toLowerCase().includes(w));
                    if (!looksRight) return;

                    try {
                        const abs = new URL(href, request.url);
                        if (abs.origin !== origin) return;
                        abs.hash = '';
                        candidates.push(abs.toString());
                    } catch {
                        /* ignore malformed hrefs */
                    }
                });

                const unique = [...new Set(candidates)].slice(0, maxPagesPerSite - 1);
                for (const url of unique) {
                    await crawler.addRequests([{ url, userData: { projectId, depth: 1 } }]);
                }
            }
        },
    });

    await crawler.run(siteQueue);
}

/* ================================================================== */
/* STEP 4. Score, rank and save.                                      */
/* ================================================================== */

let withEmail = 0;

for (const record of results.values()) {
    const ownDomains = record.linkedSites.map((u) => safeHost(u)).filter(Boolean);
    const { emails } = rankEmails(record.rawHits, ownDomains);
    const kept = emails.filter((e) => e.score >= minimumScore);

    if (kept.length) withEmail += 1;

    await Actor.pushData({
        projectId: record.projectId,
        projectName: record.projectName,
        projectUrl: record.projectUrl,
        state: record.state,
        goal: record.goal,
        pledged: record.pledged,
        currency: record.currency,
        percentFunded: record.goal ? Math.round((record.pledged / record.goal) * 1000) / 10 : null,
        country: record.country,
        location: record.location,

        creatorName: record.creatorName,
        creatorUrl: record.creatorUrl,

        bestEmail: kept.length ? kept[0].email : null,
        bestEmailConfidence: kept.length ? kept[0].confidence : null,
        bestEmailScore: kept.length ? kept[0].score : null,
        bestEmailFoundOn: kept.length ? kept[0].sourceUrl : null,
        whyThisEmail: kept.length ? kept[0].reasons.join('; ') : null,

        allEmails: kept.map((e) => ({
            email: e.email, score: e.score, confidence: e.confidence, source: e.source, sourceUrl: e.sourceUrl, reasons: e.reasons,
        })),

        linkedSites: record.linkedSites,
        socialProfiles: record.socialProfiles,
        pagesChecked: record.pagesChecked,
        blurb: record.blurb,
        scrapedAt: new Date().toISOString(),
    });
}

log.info(`Done. Found at least one address for ${withEmail} of ${results.size} underfunded projects.`);

await Actor.exit();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeOrigin(url) {
    try {
        return new URL(url).origin;
    } catch {
        return url;
    }
}

function safeHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}
