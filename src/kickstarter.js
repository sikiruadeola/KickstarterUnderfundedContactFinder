/**
 * kickstarter.js
 *
 * Everything that talks to Kickstarter lives here.
 *
 * Discovery uses Kickstarter's own public search endpoint, the exact one
 * their own site calls when you browse or filter by category:
 *   https://www.kickstarter.com/discover/advanced?format=json
 * No login, no key, no cookie. It hands back project name, funding numbers,
 * backer count, country, location and the creator id, name and profile link.
 *
 * Reading a single project's own page is also fully public with no login
 * wall. That page carries the full story text and, further down, a short
 * biography for the creator plus any outbound links they have added, most
 * often their own website.
 *
 * Kickstarter runs Cloudflare in front of the site, more aggressively than
 * YouTube ever did, so every request here goes out with a realistic browser
 * header set through Crawlee's gotScraping, the same approach already
 * proven on the YouTube tool.
 *
 * Known hard limit worth knowing: one single search query can only ever
 * reach twenty four hundred rows total, page two hundred works, page two
 * hundred and one is a genuine HTTP 404. Splitting a search by state, by
 * category or by search term is the only way past that ceiling.
 */

import { gotScraping, log } from 'crawlee';
import * as cheerio from 'cheerio';

const DISCOVER_ROOT = 'https://www.kickstarter.com/discover/advanced';

async function discoverGet(params, proxyUrl) {
    const url = new URL(DISCOVER_ROOT);
    url.searchParams.set('format', 'json');
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await gotScraping({
        url: url.toString(),
        proxyUrl: proxyUrl || undefined,
        timeout: { request: 30000 },
        headerGeneratorOptions: {
            browsers: ['chrome'],
            devices: ['desktop'],
            locales: ['en-US'],
        },
        responseType: 'json',
    });

    return response.body;
}

/**
 * Walks one category, one state, page by page, until either the pages run
 * dry or the twenty four hundred row ceiling is hit. Stops on the first
 * empty page or the first 404, whichever comes first, rather than guessing
 * a fixed page count.
 */
export async function discoverProjects({ categoryId, state, sort = 'newest', maxPages = 200, proxyUrl }) {
    const projects = [];

    for (let page = 1; page <= maxPages; page += 1) {
        let body;
        try {
            body = await discoverGet({ category_id: categoryId, state, sort, page }, proxyUrl);
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
 * Reads a single project's own public page.
 *
 * Returns the full story text, a best guess at the creator's own short
 * biography text, and every outbound link found anywhere on the page that
 * does not point back at kickstarter.com itself.
 */
export async function fetchProjectPage(projectUrl, proxyUrl) {
    try {
        const response = await gotScraping({
            url: projectUrl,
            proxyUrl: proxyUrl || undefined,
            timeout: { request: 30000 },
            headerGeneratorOptions: {
                browsers: ['chrome'],
                devices: ['desktop'],
                locales: ['en-US'],
            },
        });

        const $ = cheerio.load(response.body);

        const storyText = $('body').text().replace(/\s+/g, ' ').slice(0, 200000);

        const links = new Set();
        $('a[href^="http"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href) links.add(href);
        });

        return {
            storyText,
            links: cleanLinks([...links]),
            rawHtml: response.body,
        };
    } catch (error) {
        log.warning(`Could not read project page ${projectUrl}: ${error.message}`);
        return { storyText: '', links: [], rawHtml: '' };
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

/**
 * Split discovered links into a creator's own site versus social profiles,
 * same idea as the YouTube tool. Social platforms hide contact details
 * behind their own logins, so they are recorded but never crawled.
 */
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
