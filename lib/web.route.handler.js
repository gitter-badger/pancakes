/**
 * Author: Jeff Whelpley
 * Date: 10/19/14
 *
 * Common functions used by all server plugins
 */
var Q        = require('q');
var _        = require('lodash');
var lruCache = require('lru-cache');

var defaultPageCache = lruCache({ max: 100, maxAge: 60000 });
var routeInfoCache = {};
var appRouteCache = {};
var injector, clientPlugin, appConfigs;

/**
 * Initialize the handler with the dependency injector
 * @param opts
 */
function init(opts) {
    injector = opts.injector;
    clientPlugin = opts.clientPlugin;
    appConfigs = injector.loadModule('appConfigs');
}

/***
 * Convert a pattern from the database into a legit regex pattern
 * @param pattern
 */
function convertUrlPatternToRegex(pattern) {
    pattern = pattern.replace(new RegExp('{[a-zA-Z0-9\\-_~]*}', 'gi'), '[a-zA-Z0-9\\-_~]+');
    pattern = pattern.replace(/\//g, '\\/');
    pattern = '^' + pattern + '$';
    return new RegExp(pattern);
}

/**
 * Use a given pattern to extract tokens from a given URL
 * @param pattern
 * @param url
 * @returns {{}}
 */
function getTokenValuesFromUrl(pattern, url) {
    var tokenValues = {};
    var idx;
    var tokenName;
    var tokenValue;

    while (true)
    {
        idx = pattern.indexOf('{');
        if (idx < 0) {
            break;
        }

        url = url.substring(idx);
        pattern = pattern.substring(idx + 1);

        idx = pattern.indexOf('}');

        if (idx < 0) {
            break;
        }

        tokenName = pattern.substring(0, idx);

        if (idx === (pattern.length - 1)) {
            pattern = '';
        }
        else {
            pattern = pattern.substring(idx + 1);
        }

        idx = url.indexOf('/');
        idx = idx < 0 ? url.length : idx;

        if (pattern && url.indexOf(pattern) >= 0) {
            idx = Math.min(idx, url.indexOf(pattern));
        }

        tokenValue = url.substring(0, idx);
        url = url.substring(idx);

        tokenValues[tokenName] = tokenValue;
    }

    return tokenValues;
}

/**
 * Get array of routes for app. This is essentially information from
 * the main app config file that is the root dir of each app (i.e. in
 * the {projectRoot}/app/{appName}/{appName}.app.js file)
 *
 * @param appName
 * @returns [] Array of routeInfo objects
 */
function getRoutes(appName) {
    if (appRouteCache[appName]) { return appRouteCache[appName]; }      // if route info already cached, return that

    var appConfig = appConfigs[appName];
    var routes = [];

    _.each(appConfig.routes, function (route) {                 // loop through routes in the .app file
        _.each(route.urls, function (urlPattern) {              // create separate routeInfo for each URL
            routes.push(_.extend({
                urlPattern:     urlPattern,
                urlRegex:       convertUrlPatternToRegex(urlPattern),
                layout:         route.layout || appConfig.defaultLayout || appName,
                wrapper:        route.wrapper || appConfig.defaultWrapper || 'server.page',
                strip:          route.strip || appConfig.defaultStrip || true,
                contentType:    route.contentType,
                data:           route.data || appConfig.data,
                serverOnly:     appConfig.serverOnly
            }, route));
        });
    });

    appRouteCache[appName] = routes;
    return routes;
}

/**
 * Get info for particular route
 * @param appName
 * @param urlRequest
 * @param query
 * @param lang
 * @returns {{}} The routeInfo for a particular request
 */
function getRouteInfo(appName, urlRequest, query, lang) {

    // if route info already in cache, return it
    var cacheKey = appName + '||' + urlRequest;
    var cachedRouteInfo = routeInfoCache[cacheKey];
    if (cachedRouteInfo) {
        cachedRouteInfo.query = query;  // query shouldn't be cached
        return cachedRouteInfo;
    }

    // get the routes and then find the info that matches the current URL
    var url = urlRequest.toLowerCase();
    var i, route, routeInfo;
    var routes = getRoutes(appName);
    if (routes) {

        // loop through routes trying to find the one that matches
        for (i = 0; i < routes.length; i++) {
            route = routes[i];

            // if there is a match, save the info to cache and return it
            if (route.urlRegex.test(url)) {
                routeInfo = _.extend({
                    appName:    appName,
                    lang:       lang,
                    url:        urlRequest,
                    query:      query,
                    tokens:     getTokenValuesFromUrl(route.urlPattern, urlRequest)
                }, route);

                routeInfoCache[cacheKey] = routeInfo;
                return routeInfo;
            }
        }
    }

    // if we get here, then no route found, so throw 404 error
    throw new Error('404: ' + appName + ' ' + urlRequest + ' is not a valid request');
}

/**
 * If a default value doesn't exist in the model, set it
 * @param model
 * @param defaults
 */
function setDefaults(model, defaults) {
    if (!defaults) { return; }

    _.each(defaults, function (value, key) {
        if (model[key] === undefined) {
            model[key] = value;
        }
    });
}

/**
 * Get the initial model for a given page
 * @param routeInfo
 * @param page
 */
function getInitialModel(routeInfo, page) {
    var initModelDeps = {
        appName:    routeInfo.appName,
        tokens:     routeInfo.tokens,
        routeInfo:  routeInfo,
        defaults:   page.defaults,
        currentScope: {}
    };

    // if no model, just return empty object
    if (!page.model) {
        return new Q({});
    }
    // if function, inject and the returned value is the model
    else if (_.isFunction(page.model)) {
        return Q.when(injector.loadModule(page.model, null, { dependencies: initModelDeps }));
    }
    else {
        throw new Error(routeInfo.name + ' page invalid model() format: ' + page.model);
    }
}

/**
 * This function is called by the server plugin when we have a request and we need to
 * process it. The plugin should handle translating the server platform specific values
 * into our routeInfo
 *
 * @param routeInfo
 * @param callbacks
 */
function processWebRequest(routeInfo, callbacks) {
    var appName = routeInfo.appName;
    var serverOnly = !!routeInfo.query.server;
    var page = injector.loadModule('app/' + appName + '/pages/' + routeInfo.name + '.page');

    // get the callbacks
    var serverPreprocessing = callbacks.serverPreprocessing || function () { return false; };
    var appAddToModel = callbacks.addToModel || function () {};
    var pageCacheService = callbacks.pageCacheService || defaultPageCache;
    var initialModel, cacheKey;

    return getInitialModel(routeInfo, page)
        .then(function (model) {
            initialModel = model || {};

            // if the server pre-processing returns true, then return without doing anything
            // this is because the pre-processor sent a reply to the user already
            if (serverPreprocessing(routeInfo, page, model)) {
                return true;
            }

            cacheKey = routeInfo.url + '||' + JSON.stringify(model);
            return pageCacheService.get({ key: cacheKey });
        })
        .then(function (cachedPage) {
            if (cachedPage === true) { return null; }
            if (cachedPage && !serverOnly) { return cachedPage; }

            // allow the app level to modify the model before rendering
            appAddToModel(initialModel, routeInfo);

            // finally use the client side plugin to do the rendering
            var renderedPage = clientPlugin.renderPage(routeInfo, page, initialModel);

            if (!serverOnly) {
                pageCacheService.set({ key: cacheKey, value: renderedPage });
            }

            return renderedPage;
        });
}

// expose functions for testing
module.exports = {
    init: init,
    getRouteInfo: getRouteInfo,
    getRoutes: getRoutes,
    getTokenValuesFromUrl: getTokenValuesFromUrl,
    convertUrlPatternToRegex: convertUrlPatternToRegex,
    processWebRequest: processWebRequest,
    setDefaults: setDefaults,
    getInitialModel: getInitialModel
};
