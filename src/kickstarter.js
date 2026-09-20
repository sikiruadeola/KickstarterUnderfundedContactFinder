/**
 * kickstarter.js
 *
 * Everything that talks to Kickstarter lives here.
 *
 * Discovery uses Kickstarter's own public search endpoint, the exact one
 * their own site calls when you browse or filter by category:
 *   https://www.kickstarter.com/discover/advanced?format=json
 * No login, no key, no cookie.
 *
 * The one thing that changed after the first attempt at this: every single
 * request here now goes out through its own brand new proxy address, never
 * a shared one reused across the run. A single address making hundreds of
 * requests in a row looks nothing like a real visitor, but hundreds of
 * different addresses each making one request looks exactly like hundreds
 * of different people, which is the actual behaviour real, working
 * Kickstarter scrapers rely on.
 *
 * Known hard limit worth knowing: one single search query can only ever
 * reach twenty four hundred rows total, page two hundred works, page two
 * hundred and one is a genuine HTTP 404. Splitting a search by state, by
 * category or by search term is the only way past that ceiling.
 */

import { gotScraping, log } from 'crawlee';
import * as cheerio from 'cheerio';

const DISCOVER_ROOT = 'https://www.kickstarter.com/discover/advanced';

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function freshGet(url, proxyConfiguration, responseType) {
    // A brand new address for this one request, and only this one request.
    const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

    // A short, human sized, randomised pause before every single request,
    // so a burst of requests never lands in an implausibly tight window
    // even though each one comes from a different address.
    await sleep(1500 + Math.random() * 2500);

    return gotScraping({
        url,
        proxyUrl,
        timeout: { request: 30000 },
        headerGeneratorOptions: {
            browsers: ['chrome'],
            devices: ['desktop'],
            locales: ['en-US'],
        },
        responseType,
        retry: { limit: 0 },
    });
}

/**
 * Walks one category, one state, page by page, stopping on the first empty
 * page, the first real error, or the two hundred page ceiling Kickstarter
 * itself enforces, whichever comes first. Every page is its own fresh
 * address.
 */
export async function discoverProjects({ categoryId, state, sort = 'newest', maxPages = 200, proxyConfiguration }) {
    const projects = [];

    for (let page = 1; page <= maxPages; page += 1) {
        const url = `${DISCOVER_ROOT}?format=json&category_id=${categoryId}&state=${state}&sort=${sort}&page=${page}`;

        let body;
        try {
            const response = await freshGet(url, proxyConfiguration, 'json');
            body = response.body;
        } catch (error) {
            log.warning(`Discovery page ${page} for state ${state} failed: ${error.message}. Stopping this state here.`);
            break;
        }

        const pageProjects = body?.projects || [];
        if (pageProjects.length === 0) {
            log.info(`State ${state}, page ${page} came back empty. Reached the end of this slice.`);
            break;
        }

        projects.push(...pageProjects);
    }

    return projects;
}

/**
 * Reads a single project's own public page, its own fresh address too.
 * Returns the full story text and every outbound link found anywhere on
 * the page that does not point back at kickstarter.com itself.
 */
export async function fetchProjectPage(projectUrl, proxyConfiguration) {
    try {
        const response = await freshGet(projectUrl, proxyConfiguration, 'text');
        const $ = cheerio.load(response.body);

        const storyText = $('body').text().replace(/\s+/g, ' ').slice(0, 200000);

        const links = new Set();
        $('a[href^="http"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href) links.add(href);
        });

        return { storyText, links: cleanLinks([...links]) };
    } catch (error) {
        log.warning(`Could not read project page ${projectUrl}: ${error.message}`);
        return { storyText: '', links: [] };
    }
}

function cleanLinks(urls) {
    const skipHosts = [
        'kickstarter.com', 'ksr-ugc.imgix.net', 'facebook.com', 'twitter.com', 'x.com',
        'instagram.com', 'google.com', 'gstatic.com', 'googleapis.com', 'apple.com',
        'play.google.com', 'youtube.com', 'youtu.be', 'schema.org', 'w3.org',
        'trustarc.com', 'privacy-mgmt.com', 'sift.com', 'qualtrics.com',
    ];

    const out = new Map();

    for (const raw of urls) {
        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            continue;
        }

        const host = parsed.hostname.replace(/^www\./, '');
        if (skipHosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;

        parsed.hash = '';
        for (const p of [...parsed.searchParams.keys()]) {
            if (/^(utm_|fbclid|gclid|ref$)/i.test(p)) parsed.searchParams.delete(p);
        }

        const key = `${host}${parsed.pathname}`;
        if (!out.has(key)) out.set(key, parsed.toString());
    }

    return [...out.values()];
}

export function splitLinks(urls) {
    const socialHosts = [
        'twitter.com', 'x.com', 'instagram.com', 'facebook.com', 'tiktok.com',
        'linkedin.com', 'threads.net', 'reddit.com', 'discord.gg', 'discord.com',
        'patreon.com', 'twitch.tv', 'linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co',
        'substack.com', 'medium.com', 'github.com', 'pinterest.com', 'vimeo.com',
    ];

    const ownSites = [];
    const socialProfiles = [];

    for (const url of urls) {
        let host;
        try {
            host = new URL(url).hostname.replace(/^www\./, '');
        } catch {
            continue;
        }

        const isAggregator = ['linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co'].some(
            (h) => host === h || host.endsWith(`.${h}`),
        );

        if (isAggregator) {
            ownSites.push(url);
        } else if (socialHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
            socialProfiles.push(url);
        } else {
            ownSites.push(url);
        }
    }

    return { ownSites, socialProfiles };
}
