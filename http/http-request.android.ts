/**
 * Android specific http request implementation.
 */
import imageSource = require("image-source");
import types = require("utils/types");
import utils = require("utils/utils");

// this is imported for definition purposes only
import http = require("http");
import platform = require("platform");

var requestIdCounter = 0;
var pendingRequests = {};

var completeCallback = new com.tns.Async.CompleteCallback({
    onComplete: function (result: any, context: any) {
        // as a context we will receive the id of the request
        onRequestComplete(context, result);
    }
});

function onRequestComplete(requestId: number, result: com.tns.Async.Http.RequestResult) {
    var callbacks = pendingRequests[requestId];
    delete pendingRequests[requestId];

    if (result.error) {
        callbacks.rejectCallback(new Error(result.error.toString()));
        return;
    }

    // read the headers
    var headers = {};
    if (result.headers) {
        var jHeaders = result.headers;
        var length = jHeaders.size();
        var i;
        var pair: com.tns.Async.Http.KeyValuePair;
        for (i = 0; i < length; i++) {
            pair = jHeaders.get(i);
            headers[pair.key] = pair.value;
        }
    }

    callbacks.resolveCallback({
        content: {
            raw: result.raw,
            toString: () => {
                if (types.isString(result.responseAsString)) {
                    return result.responseAsString;
                } else {
                    throw new Error("Response content may not be converted to string");
                }
            },
            toJSON: () => { return utils.parseJSON(result.responseAsString); },
            toImage: () => {
                return new Promise<imageSource.ImageSource>((resolveImage, rejectImage) => {
                    if (result.responseAsImage != null) {
                        resolveImage(imageSource.fromNativeSource(result.responseAsImage));
                    }
                    else {
                        rejectImage(new Error("Response content may not be converted to an Image"));
                    }
                });
            }
        },
        statusCode: result.statusCode,
        headers: headers
    });
}

function buildJavaOptions(options: http.HttpRequestOptions) {
    if (!types.isString(options.url)) {
        throw new Error("Http request must provide a valid url.");
    }

    var javaOptions = new com.tns.Async.Http.RequestOptions();

    //HACK to fix the encoding    https://github.com/NativeScript/NativeScript/pull/1228
    var originalUrl = options.url;
    try {
        var decodedUrl = decodeURI(originalUrl);
        if (decodedUrl === originalUrl) {
            //the url is not encoded, fix the %
            options.url.replace("%", "%25");
        }
    }
    catch (e) {
        //This means something crash with js decode encode (url malformed)
        // if we don't catch it will be and infinite loop, revert changes
        options.url = originalUrl;
    }
    javaOptions.url = options.url;
    //End of the HACK

    if (types.isString(options.method)) {
        javaOptions.method = options.method;
    }
    if (types.isString(options.content) || options.content instanceof FormData) {
        javaOptions.content = options.content.toString();
    }
    if (types.isNumber(options.timeout)) {
        javaOptions.timeout = options.timeout;
    }

    if (options.headers) {
        var arrayList = new java.util.ArrayList<com.tns.Async.Http.KeyValuePair>();
        var pair = com.tns.Async.Http.KeyValuePair;

        for (var key in options.headers) {
            arrayList.add(new pair(key, options.headers[key] + ""));
        }

        javaOptions.headers = arrayList;
    }

    // pass the maximum available image size to the request options in case we need a bitmap conversion
    var screen = platform.screen.mainScreen;
    javaOptions.screenWidth = screen.widthPixels;
    javaOptions.screenHeight = screen.heightPixels;

    return javaOptions;
}

export function request(options: http.HttpRequestOptions): Promise<http.HttpResponse> {
    if (!types.isDefined(options)) {
        // TODO: Shouldn't we throw an error here - defensive programming
        return;
    }
    return new Promise<http.HttpResponse>((resolve, reject) => {

        try {
            // initialize the options
            var javaOptions = buildJavaOptions(options);

            // remember the callbacks so that we can use them when the CompleteCallback is called
            var callbacks = {
                resolveCallback: resolve,
                rejectCallback: reject
            };
            pendingRequests[requestIdCounter] = callbacks;

            //make the actual async call
            com.tns.Async.Http.MakeRequest(javaOptions, completeCallback, new java.lang.Integer(requestIdCounter));

            // increment the id counter
            requestIdCounter++;
        } catch (ex) {
            reject(ex);
        }
    });
}
