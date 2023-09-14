/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

let CUSTOM_SCHEMA_NAMESPACE = "_sitesinternal"

export default async function initMartech (config) {

  const { sampleRUM,
         schemaNamespace,
         edgeConfigId,
         imsOrgId } = config;

  CUSTOM_SCHEMA_NAMESPACE = schemaNamespace || CUSTOM_SCHEMA_NAMESPACE;
  initAnalyticsTrackingQueue();
  setupAnalyticsTrackingWithAlloy(document, edgeConfigId, imsOrgId);

  const cwv = {};

  // Forward the RUM CWV cached measurements to edge using WebSDK before the page unloads
  sampleRUM.always.on('leave', () => {
    if (!Object.keys(cwv).length) return;
    analyticsTrackCWV(cwv);
  });

  // Listen to changes in consent
  sampleRUM.always.on('consent', ( {target} ) => {
    if (target) {
      analyticsSetConsent(target.ANALYTICS === 'ALLOW');
    }
  });

  // Callback to RUM CWV checkpoint in order to cache the measurements
  sampleRUM.always.on('cwv', async (data) => {
    if (!data.cwv) return;
    Object.assign(cwv, data.cwv);
  });

  sampleRUM.always.on('404', analyticsTrack404);
  sampleRUM.always.on('error', analyticsTrackError);
  sampleRUM.always.on('formsubmit', ({element}) => analyticsTrackFormSubmission(element));

  // Declare conversionEvent, bufferTimeoutId and tempConversionEvent,
  // outside the convert function to persist them for buffering between
  // subsequent convert calls
  const CONVERSION_EVENT_TIMEOUT_MS = 100;
  let bufferTimeoutId;
  let conversionEvent;
  let tempConversionEvent;
  sampleRUM.always.on('convert', (data) => {
    const { element } = data;
    // eslint-disable-next-line no-undef
    if (!element || !alloy) {
      return;
    }

    if (element.tagName === 'FORM') {
      conversionEvent = {
        ...data,
        event: 'Form Complete',
      };

      if (conversionEvent.event === 'Form Complete'
        // Check for undefined, since target can contain value 0 as well, which is falsy
        && (data.target === undefined || data.source === undefined)
      ) {
        // If a buffer has already been set and tempConversionEvent exists,
        // merge the two conversionEvent objects to send to alloy
        if (bufferTimeoutId && tempConversionEvent) {
          conversionEvent = { ...tempConversionEvent, ...conversionEvent };
        } else {
          // Temporarily hold the conversionEvent object until the timeout is complete
          tempConversionEvent = { ...conversionEvent };

          // If there is partial form conversion data,
          // set the timeout buffer to wait for additional data
          bufferTimeoutId = setTimeout(async () => {
            analyticsTrackConversion({ ...conversionEvent });
            tempConversionEvent = undefined;
            conversionEvent = undefined;
          }, CONVERSION_EVENT_TIMEOUT_MS);
        }
      }
      return;
    }

    analyticsTrackConversion({ ...data });
    tempConversionEvent = undefined;
    conversionEvent = undefined;
  });
}

/**
 * Returns experiment id and variant running
 * @returns {{experimentVariant: *, experimentId}}
 */
export function getExperimentDetails() {
  if (!window.hlx || !window.hlx.experiment) {
    return null;
  }
  const { id: experimentId, selectedVariant: experimentVariant } = window.hlx.experiment;
  return { experimentId, experimentVariant };
}

/**
 * Returns script that initializes a queue for each alloy instance,
 * in order to be ready to receive events before the alloy library is loaded
 * Documentation
 * https://experienceleague.adobe.com/docs/experience-platform/edge/fundamentals/installing-the-sdk.html?lang=en#adding-the-code
 * @type {string}
 */
function getAlloyInitScript() {
  return `!function(n,o){o.forEach(function(o){n[o]||((n.__alloyNS=n.__alloyNS||[]).push(o),n[o]=
  function(){var u=arguments;return new Promise(function(i,l){n[o].q.push([i,l,u])})},n[o].q=[])})}(window,["alloy"]);`;
}

/**
 * Enhance all events with additional details, like experiment running,
 * before sending them to the edge
 * @param options event in the XDM schema format
 */
function enhanceAnalyticsEvent(options) {
  const experiment = getExperimentDetails();
  options.xdm[CUSTOM_SCHEMA_NAMESPACE] = {
    ...options.xdm[CUSTOM_SCHEMA_NAMESPACE],
    ...(experiment && { experiment }), // add experiment details, if existing, to all events
  };
  console.debug(`enhanceAnalyticsEvent complete: ${JSON.stringify(options)}`);
}

/**
 * Returns alloy configuration
 * Documentation https://experienceleague.adobe.com/docs/experience-platform/edge/fundamentals/configuring-the-sdk.html
 */
function getAlloyConfiguration(document, edgeConfigId, imsOrgId) {
  const { hostname } = document.location;

  return {
    // enable while debugging
    debugEnabled: hostname.startsWith('localhost') || hostname.includes('--'),
    // disable when clicks are also tracked via sendEvent with additional details
    clickCollectionEnabled: true,
    // adjust default based on customer use case
    defaultConsent: 'pending',
    edgeConfigId: edgeConfigId,
    orgId: imsOrgId,
    onBeforeEventSend: (options) => enhanceAnalyticsEvent(options),
  };
}

/**
 * Create inline script
 * @param document
 * @param element where to create the script element
 * @param innerHTML the script
 * @param type the type of the script element
 * @returns {HTMLScriptElement}
 */
function createInlineScript(document, element, innerHTML, type) {
  const script = document.createElement('script');
  script.type = type;
  script.innerHTML = innerHTML;
  element.appendChild(script);
  return script;
}

/**
 * Sends an analytics event to alloy
 * @param xdmData - the xdm data object
 * @returns {Promise<*>}
 */
async function sendAnalyticsEvent(xdmData) {
  // eslint-disable-next-line no-undef
  if (!alloy) {
    console.warn('alloy not initialized, cannot send analytics event');
    return Promise.resolve();
  }
  // eslint-disable-next-line no-undef
  return alloy('sendEvent', {
    documentUnloading: true,
    xdm: xdmData,
  });
}

/**
 * Sets Adobe standard v1.0 consent for alloy based on the input
 * Documentation: https://experienceleague.adobe.com/docs/experience-platform/edge/consent/supporting-consent.html?lang=en#using-the-adobe-standard-version-1.0
 * @param approved
 * @returns {Promise<*>}
 */
async function analyticsSetConsent(approved) {
  // eslint-disable-next-line no-undef
  if (!alloy) {
    console.warn('alloy not initialized, cannot set consent');
    return Promise.resolve();
  }
  // eslint-disable-next-line no-undef
  return alloy('setConsent', {
    consent: [{
      standard: 'Adobe',
      version: '1.0',
      value: {
        general: approved ? 'in' : 'out',
      },
    }],
  });
}

/**
 * Basic tracking for page views with alloy
 * @param document
 * @param additionalXdmFields
 * @returns {Promise<*>}
 */
async function analyticsTrackPageViews(document, additionalXdmFields = {}) {
  const xdmData = {
    eventType: 'web.webpagedetails.pageViews',
    web: {
      webPageDetails: {
        pageViews: {
          value: 1,
        },
        name: `${document.title}`,
      },
    },
    [CUSTOM_SCHEMA_NAMESPACE]: {
      ...additionalXdmFields,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

/**
 * Initializes event queue for analytics tracking using alloy
 * @returns {Promise<void>}
 */
async function initAnalyticsTrackingQueue() {
  createInlineScript(document, document.body, getAlloyInitScript(), 'text/javascript');
}

/**
 * Sets up analytics tracking with alloy (initializes and configures alloy)
 * @param document
 * @returns {Promise<void>}
 */
export async function setupAnalyticsTrackingWithAlloy(document, edgeConfigId, imsOrgId) {
  // eslint-disable-next-line no-undef
  if (!alloy) {
    console.warn('alloy not initialized, cannot configure');
    return;
  }
  // eslint-disable-next-line no-undef
  const configurePromise = alloy('configure', getAlloyConfiguration(document, edgeConfigId, imsOrgId));

  // Custom logic can be inserted here in order to support early tracking before alloy library
  // loads, for e.g. for page views
  const pageViewPromise = analyticsTrackPageViews(document); // track page view early

  await import('./alloy.min.js');
  await Promise.all([configurePromise, pageViewPromise]);
}

/**
 * Basic tracking for link clicks with alloy
 * Documentation: https://experienceleague.adobe.com/docs/experience-platform/edge/data-collection/track-links.html
 * @param element
 * @param linkType
 * @param additionalXdmFields
 * @returns {Promise<*>}
 */
async function analyticsTrackLinkClicks(element, linkType = 'other', additionalXdmFields = {}) {
  const xdmData = {
    eventType: 'web.webinteraction.linkClicks',
    web: {
      webInteraction: {
        URL: `${element.href}`,
        // eslint-disable-next-line no-nested-ternary
        name: `${element.text ? element.text.trim() : (element.innerHTML ? element.innerHTML.trim() : '')}`,
        linkClicks: {
          value: 1,
        },
        type: linkType,
      },
    },
    [CUSTOM_SCHEMA_NAMESPACE]: {
      ...additionalXdmFields,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

/**
 * Basic tracking for CWV events with alloy
 * @param cwv
 * @returns {Promise<*>}
 */
async function analyticsTrackCWV(cwv) {
  const xdmData = {
    eventType: 'web.performance.measurements',
    [CUSTOM_SCHEMA_NAMESPACE]: {
      cwv,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

/**
 * Basic tracking for 404 errors with alloy
 * @param data
 * @param additionalXdmFields
 * @returns {Promise<*>}
 */
async function analyticsTrack404(data, additionalXdmFields = {}) {
  const xdmData = {
    eventType: 'web.webpagedetails.pageViews',
    web: {
      webPageDetails: {
        pageViews: {
          value: 0,
        },
      },
    },
    [CUSTOM_SCHEMA_NAMESPACE]: {
      isPageNotFound: true,
      ...additionalXdmFields,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

async function analyticsTrackError(data, additionalXdmFields = {}) {
  const xdmData = {
    eventType: 'web.webpagedetails.pageViews',
    web: {
      webPageDetails: {
        pageViews: {
          value: 0,
        },
        isErrorPage: true,
      },
    },
    [CUSTOM_SCHEMA_NAMESPACE]: {
      ...additionalXdmFields,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

async function analyticsTrackConversion(data, additionalXdmFields = {}) {
  const { source: conversionName, target: conversionValue, element } = data;

  const xdmData = {
    eventType: 'web.webinteraction.conversion',
    [CUSTOM_SCHEMA_NAMESPACE]: {
      conversion: {
        conversionComplete: 1,
        conversionName,
        conversionValue,
      },
      ...additionalXdmFields,
    },
  };

  if (element.tagName === 'FORM') {
    xdmData.eventType = 'web.formFilledOut';
    const formId = element?.id || element?.dataset?.action;
    xdmData[CUSTOM_SCHEMA_NAMESPACE].form = {
      ...(formId && { formId }),
      // don't count as form complete, as this event should be tracked separately,
      // track only the details of the form together with the conversion
      formComplete: 0,
    };
  } else if (element.tagName === 'A') {
    xdmData.eventType = 'web.webinteraction.linkClicks';
    xdmData.web = {
      webInteraction: {
        URL: `${element.href}`,
        // eslint-disable-next-line no-nested-ternary
        name: `${element.text ? element.text.trim() : (element.innerHTML ? element.innerHTML.trim() : '')}`,
        linkClicks: {
          // don't count as link click, as this event should be tracked separately,
          // track only the details of the link with the conversion
          value: 0,
        },
        type: 'other',
      },
    };
  }

  return sendAnalyticsEvent(xdmData);
}

/**
 * Basic tracking for form submissions with alloy
 * @param element
 * @param additionalXdmFields
 * @returns {Promise<*>}
 */
async function analyticsTrackFormSubmission(element, additionalXdmFields = {}) {
  const formId = element?.id || element?.dataset?.action;
  const xdmData = {
    eventType: 'web.formFilledOut',
    [CUSTOM_SCHEMA_NAMESPACE]: {
      form: {
        ...(formId && { formId }),
        formComplete: 1,
      },
      ...additionalXdmFields,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

/**
 * Basic tracking for video play with alloy
 * @param element
 * @param additionalXdmFields
 * @returns {Promise<*>}
 */
async function analyticsTrackVideo({
  id, name, type, hasStarted, hasCompleted, progressMarker,
}, additionalXdmFields) {
  const primaryAssetReference = {
    id: `${id}`,
    dc: {
      title: `${name}`,
    },
    showType: `${type}`,
  };
  const baseXdm = {
    [CUSTOM_SCHEMA_NAMESPACE]: {
      media: {
        mediaTimed: {
          primaryAssetReference,
        },
      },
      ...additionalXdmFields,
    },
  };

  if (hasStarted) {
    baseXdm[CUSTOM_SCHEMA_NAMESPACE].media.mediaTimed.impressions = { value: 1 };
  } else if (hasCompleted) {
    baseXdm[CUSTOM_SCHEMA_NAMESPACE].media.mediaTimed.completes = { value: 1 };
  } else if (progressMarker) {
    baseXdm[CUSTOM_SCHEMA_NAMESPACE].media.mediaTimed[progressMarker] = { value: 1 };
  } else {
    return Promise.resolve();
  }

  return sendAnalyticsEvent(baseXdm);
}
