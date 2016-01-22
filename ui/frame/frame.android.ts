﻿import frameCommon = require("./frame-common");
import definition = require("ui/frame");
import pages = require("ui/page");
import trace = require("trace");
import observable = require("data/observable");
import utils = require("utils/utils");
import application = require("application");
import types = require("utils/types");

global.moduleMerge(frameCommon, exports);

var TAG = "_fragmentTag";
var OWNER = "_owner";
var HIDDEN = "_hidden";
var INTENT_EXTRA = "com.tns.activity";
var ANDROID_FRAME = "android_frame";
var BACKSTACK_TAG = "_backstackTag";
var NAV_DEPTH = "_navDepth";
var CLEARING_HISTORY = "_clearingHistory";
var activityInitialized = false;

var navDepth = -1;

var PageFragmentBody = (<any>android.app.Fragment).extend({
        
    onCreate: function (savedInstanceState: android.os.Bundle) {
        trace.write(`PageFragmentBody.onCreate(${savedInstanceState})`, trace.categories.NativeLifecycle);
        this.super.onCreate(savedInstanceState);
        this.super.setHasOptionsMenu(true);
    },

    onCreateView: function (inflater: android.view.LayoutInflater, container: android.view.ViewGroup, savedInstanceState: android.os.Bundle): android.view.View {
        trace.write(`PageFragmentBody.onCreateView(${inflater}, ${container}, ${savedInstanceState})`, trace.categories.NativeLifecycle);
        var entry = this.entry;
        var page = entry.resolvedPage;
        if (savedInstanceState && savedInstanceState.getBoolean(HIDDEN, false)) {
            this.super.getFragmentManager().beginTransaction().hide(this).commit();
            page._onAttached(this.getActivity());
        }
        else {
            onFragmentShown(this);
        }
        return page._nativeView;
    },

    onHiddenChanged: function (hidden: boolean) {
        trace.write(`PageFragmentBody.onHiddenChanged(${hidden})`, trace.categories.NativeLifecycle);
        this.super.onHiddenChanged(hidden);
        if (hidden) {
            onFragmentHidden(this);
        }
        else {
            onFragmentShown(this);
        }
    },

    onSaveInstanceState: function (outState: android.os.Bundle) {
        trace.write(`PageFragmentBody.onSaveInstanceState(${outState})`, trace.categories.NativeLifecycle);
        this.super.onSaveInstanceState(outState);
        if (this.isHidden()) {
            outState.putBoolean(HIDDEN, true);
        }
    },

    onDestroyView: function () {
        trace.write(`PageFragmentBody.onDestroyView()`, trace.categories.NativeLifecycle);
        this.super.onDestroyView();
        onFragmentHidden(this);
    },

    onDestroy: function () {
        trace.write(`PageFragmentBody.onDestroy()`, trace.categories.NativeLifecycle);
        this.super.onDestroy();
        utils.GC();
    }
});

function onFragmentShown(fragment) {
    trace.write(`onFragmentShown(${fragment.toString()})`, trace.categories.NativeLifecycle);
    if (fragment[CLEARING_HISTORY]) {
        trace.write(`${fragment.toString() } has been shown, but we are currently clearing history. Returning.`, trace.categories.NativeLifecycle);
        return null;
    }

    // TODO: consider putting entry and page in queue so we can safely extract them here. Pass the index of current navigation and extract it from here.
    // After extracting navigation info - remove this index from navigation stack.
    var frame = fragment.frame;
    var entry: definition.BackstackEntry = fragment.entry;
    var page: pages.Page = entry.resolvedPage;

    let currentNavigationContext;
    let navigationQueue = (<any>frame)._navigationQueue;
    for (let i = 0; i < navigationQueue.length; i++) {
        if (navigationQueue[i].entry === entry) {
            currentNavigationContext = navigationQueue[i];
            break;
        }
    }

    var isBack = currentNavigationContext ? currentNavigationContext.isBackNavigation : false;

    frame._currentEntry = entry;

    frame._addView(page);
    // onFragmentShown is called before NativeActivity.start where we call frame.onLoaded
    // We need to call frame.onLoaded() here so that the call to frame._addView(page) will emit the page.loaded event
    // before the page.navigatedTo event making the two platforms identical.
    if (!frame.isLoaded) {
        frame.onLoaded();
    }
    page.onNavigatedTo(isBack);
    frame._processNavigationQueue(page);
}

function onFragmentHidden(fragment) {
    trace.write(`onFragmentHidden(${fragment.toString()})`, trace.categories.NativeLifecycle);
    if (fragment[CLEARING_HISTORY]) {
        trace.write(`${fragment.toString() } has been hidden, but we are currently clearing history. Returning.`, trace.categories.NativeLifecycle);
        return null;
    }

    var entry: definition.BackstackEntry = fragment.entry;
    var page: pages.Page = entry.resolvedPage;
    // This might be a second call if the fragment is hidden and then destroyed.
    if (page && page.frame) {
        var frame = page.frame;
        frame._removeView(page);
    }
}

export class Frame extends frameCommon.Frame {
    private _android: AndroidFrame;
    private _delayedNavigationEntry: definition.BackstackEntry;
    private _isFirstNavigation = false;
    private _containerViewId: number;

    constructor() {
        super();
        this._containerViewId = android.view.View.generateViewId();
        this._android = new AndroidFrame(this);
    }

    public static get defaultAnimatedNavigation(): boolean {
        return frameCommon.Frame.defaultAnimatedNavigation;
    }
    public static set defaultAnimatedNavigation(value: boolean) {
        frameCommon.Frame.defaultAnimatedNavigation = value;
    }

    get containerViewId(): number {
        return this._containerViewId;
    }

    get android(): definition.AndroidFrame {
        return this._android;
    }

    get _nativeView(): any {
        return this._android.rootViewGroup;
    }

    public _navigateCore(backstackEntry: definition.BackstackEntry) {
        trace.write(`_navigateCore; id: ${backstackEntry.resolvedPage.id}; backstackVisible: ${this._isEntryBackstackVisible(backstackEntry)}; clearHistory: ${backstackEntry.entry.clearHistory};`, trace.categories.Navigation);

        var activity = this._android.activity;
        if (!activity) {
            // We do not have an Activity yet associated. In this case we have two execution paths:
            // 1. This is the main frame for the application
            // 2. This is an inner frame which requires a new Activity
            var currentActivity = this._android.currentActivity;
            if (currentActivity) {
                startActivity(currentActivity, backstackEntry.entry);
            }

            this._delayedNavigationEntry = backstackEntry;
            return;
        }

        var manager = activity.getFragmentManager();

        // Clear history
        if (backstackEntry.entry.clearHistory && !this._isFirstNavigation) {
            var backStackEntryCount = manager.getBackStackEntryCount();
            var i = backStackEntryCount - 1;
            var fragment: android.app.Fragment;
            while (i >= 0) {
                fragment = manager.findFragmentByTag(manager.getBackStackEntryAt(i--).getName());
                trace.write(`${fragment.toString()}[CLEARING_HISTORY] = true;`, trace.categories.NativeLifecycle);
                fragment[CLEARING_HISTORY] = true;
            }

            // Remember that the current fragment has never been added to the backStack, so mark it as well.
            if (this.currentPage) {
                fragment = manager.findFragmentByTag(this.currentPage[TAG]);
                if (fragment) {
                    fragment[CLEARING_HISTORY] = true;
                    trace.write(`${fragment.toString() }[CLEARING_HISTORY] = true;`, trace.categories.NativeLifecycle);
                }
            }

            if (backStackEntryCount) {
                var firstEntryName = manager.getBackStackEntryAt(0).getName();
                trace.write(`manager.popBackStack(${firstEntryName}, android.app.FragmentManager.POP_BACK_STACK_INCLUSIVE);`, trace.categories.NativeLifecycle);
                manager.popBackStack(firstEntryName, android.app.FragmentManager.POP_BACK_STACK_INCLUSIVE);
            }
            this._currentEntry = null;
            navDepth = -1;
        }

        navDepth++;

        var fragmentTransaction = manager.beginTransaction();

        var newFragmentTag = "fragment" + navDepth;
        var newFragment = new PageFragmentBody();

        newFragment.frame = this;
        newFragment.entry = backstackEntry;

        backstackEntry[BACKSTACK_TAG] = newFragmentTag;
        backstackEntry[NAV_DEPTH] = navDepth;

        // remember the fragment tag at page level so that we can retrieve the fragment associated with a Page instance
        backstackEntry.resolvedPage[TAG] = newFragmentTag;
        
        trace.write("Frame<" + this._domId + ">.fragmentTransaction PUSH depth = " + navDepth, trace.categories.Navigation);

        if (this._isFirstNavigation) {
            fragmentTransaction.add(this.containerViewId, newFragment, newFragmentTag);
            trace.write("fragmentTransaction.add(" + this.containerViewId + ", " + newFragment + ", " + newFragmentTag + ");", trace.categories.NativeLifecycle);
        }
        else {
            if (this.android.cachePagesOnNavigate && !backstackEntry.entry.clearHistory) {
                var currentFragmentTag = this.currentPage[TAG];
                var currentFragment = manager.findFragmentByTag(currentFragmentTag);
                if (currentFragment) {
                    fragmentTransaction.hide(currentFragment);
                    trace.write("fragmentTransaction.hide(" + currentFragment + ");", trace.categories.NativeLifecycle);
                }
                else {
                    trace.write("Could not find " + currentFragmentTag + " to hide", trace.categories.NativeLifecycle);
                }

                fragmentTransaction.add(this.containerViewId, newFragment, newFragmentTag);
                trace.write("fragmentTransaction.add(" + this.containerViewId + ", " + newFragment + ", " + newFragmentTag + ");", trace.categories.NativeLifecycle);
            }
            else {
                fragmentTransaction.replace(this.containerViewId, newFragment, newFragmentTag);
                trace.write("fragmentTransaction.replace(" + this.containerViewId + ", " + newFragment + ", " + newFragmentTag + ");", trace.categories.NativeLifecycle);
            }

            // Add to backStack if needed.
            if (this.backStack.length > 0 && this._currentEntry) {
                // We add each entry in the backstack to avoid the "Stack corrupted" mismatch
                var backstackTag = this._currentEntry[BACKSTACK_TAG];
                fragmentTransaction.addToBackStack(backstackTag);
                trace.write("fragmentTransaction.addToBackStack(" + backstackTag + ");", trace.categories.NativeLifecycle);
            }
        }

        if (!this._isFirstNavigation) {
            var animated = this._getIsAnimatedNavigation(backstackEntry.entry);

            if (this.android.cachePagesOnNavigate) {
                // Apparently, there is an Android bug with when hiding fragments with animation.
                // https://code.google.com/p/android/issues/detail?id=32405
                // When bug is fixed use animated variable.
                fragmentTransaction.setTransition(android.app.FragmentTransaction.TRANSIT_NONE);
            }
            else {
                var transition = animated ? android.app.FragmentTransaction.TRANSIT_FRAGMENT_OPEN : android.app.FragmentTransaction.TRANSIT_NONE;
                fragmentTransaction.setTransition(transition);
            }
        }

        fragmentTransaction.commit();
        trace.write("fragmentTransaction.commit();", trace.categories.NativeLifecycle);
    }

    public _goBackCore(backstackEntry: definition.BackstackEntry) {
        navDepth = backstackEntry[NAV_DEPTH];
        trace.write("Frame<" + this._domId + ">.fragmentTransaction POP depth = " + navDepth, trace.categories.Navigation);

        var manager = this._android.activity.getFragmentManager();
        if (manager.getBackStackEntryCount() > 0) {
            // pop all other fragments up until the named one
            // this handles cases where user may navigate to an inner page without adding it on the backstack
            manager.popBackStack(backstackEntry[BACKSTACK_TAG], android.app.FragmentManager.POP_BACK_STACK_INCLUSIVE);
        }
    }

    public _createUI() {
        // TODO: Implement for nested frames
        // this._android.layout = new android.widget.FrameLayout(this._context);
        // this._android.layout.setId(android.view.View.generateViewId());
    }

    public _onActivityCreated(isRestart: boolean) {
        this._onAttached(this._android.activity);

        var backstackEntry = this._currentEntry || this._delayedNavigationEntry;

        if (isRestart) {
            this._onNavigatingTo(backstackEntry, false);
            this._onNavigatedTo(backstackEntry, false);
        }
        else {
            this._isFirstNavigation = true;
            this._navigateCore(backstackEntry);
            this._isFirstNavigation = false;
        }

        this._delayedNavigationEntry = undefined;
    }

    public _popFromFrameStack() {
        if (!this._isInFrameStack) {
            return;
        }

        super._popFromFrameStack();
        if (this._android.hasOwnActivity) {
            this._android.activity.finish();
        }
    }

    public _clearAndroidReference() {
        // we should keep the reference to underlying native object, since frame can contain many pages.
    }

    public _printNativeBackStack() {
        if (!this._android.activity) {
            return;
        }
        var manager = this._android.activity.getFragmentManager();
        var length = manager.getBackStackEntryCount();
        var i = length - 1;
        console.log("---------------------------");
        console.log("Fragment Manager Back Stack (" + length + ")");
        while (i >= 0) {
            var fragment = <any>manager.findFragmentByTag(manager.getBackStackEntryAt(i--).getName());
            console.log("[ " + fragment.toString() + " ]");
        }
    }

    public _printFrameBackStack() {
        var length = this.backStack.length;
        var i = length - 1;
        console.log("---------------------------");
        console.log("Frame Back Stack (" + length + ")");
        while (i >= 0) {
            var backstackEntry = <definition.BackstackEntry>this.backStack[i--];
            console.log("[ " + backstackEntry.resolvedPage.id + " ]");
        }
    }

    public _getNavBarVisible(page: pages.Page): boolean {
        if (types.isDefined(page.actionBarHidden)) {
            return !page.actionBarHidden;
        }

        if (this._android && types.isDefined(this._android.showActionBar)) {
            return this._android.showActionBar;
        }

        return true;
    }
}

var NativeActivity = {

    get frame(): Frame {
        if (this.androidFrame) {
            return this.androidFrame.owner;
        }
        return null;
    },

    get androidFrame(): AndroidFrame {
        return this[ANDROID_FRAME];
    },

    onCreate: function (savedInstanceState: android.os.Bundle) {
        trace.write("NativeScriptActivity.onCreate(); savedInstanceState: " + savedInstanceState, trace.categories.NativeLifecycle);

        // Find the frame for this activity.
        var frameId = this.getIntent().getExtras().getInt(INTENT_EXTRA);
        for (var i = 0; i < framesCache.length; i++) {
            var aliveFrame = framesCache[i].get();
            if (aliveFrame && aliveFrame.frameId === frameId) {
                this[ANDROID_FRAME] = aliveFrame;
                break;
            }
        }

        if (!this.androidFrame) {
            throw new Error("Could not find AndroidFrame for Activity");
        }

        // If there is savedInstanceState this call will recreate all fragments that were previously in the navigation.
        // We take care of associating them with a Page from our backstack in the onAttachFragment callback.
        // If there is savedInstanceState and activityInitialized is false we are restarted but process was killed.
        // For now we treat it like first run (e.g. we are not passing savedInstanceState so no fragments are being restored).
        // When we add support for applicatioin save/load state - revise this logic.
        var isRestart = !!savedInstanceState && activityInitialized;
        this.super.onCreate(isRestart ? savedInstanceState : null);

        this.androidFrame.setActivity(this);

        // Create and set content container.
        var root = new org.nativescript.widgets.ContentLayout(this);

        this.androidFrame.rootViewGroup = root;
        this.androidFrame.rootViewGroup.setId(this.frame.containerViewId);
        this.setContentView(this.androidFrame.rootViewGroup, new org.nativescript.widgets.CommonLayoutParams());

        // If there is no instance state - we call navigateCore from here since Activity is created AFTER the navigate call and navigateCore will fail.
        
        activityInitialized = true;
        this.frame._onActivityCreated(isRestart);
    },

    onActivityResult: function (requestCode: number, resultCode: number, data: android.content.Intent) {
        this.super.onActivityResult(requestCode, resultCode, data);
        trace.write("NativeScriptActivity.onActivityResult();", trace.categories.NativeLifecycle);

        var result = application.android.onActivityResult;
        if (result) {
            result(requestCode, resultCode, data);
        }

        application.android.notify(<application.AndroidActivityResultEventData>{
            eventName: "activityResult",
            object: application.android,
            activity: this,
            requestCode: requestCode,
            resultCode: resultCode,
            intent: data
        });
    },

    onAttachFragment: function (fragment: android.app.Fragment) {
        trace.write("NativeScriptActivity.onAttachFragment() : " + fragment.getTag(), trace.categories.NativeLifecycle);
        this.super.onAttachFragment(fragment);

        if (!(<any>fragment).entry) {
            //HACK to skip native fragments not controlled by ns
            if (fragment.getTag() === "datePicker" || fragment.getTag() === "timePicker") {
                return;
            }
            //End of the hack

            // There is no entry set to the fragment, so this must be destroyed fragment that was recreated by Android.
            // We should find its corresponding page in our backstack and set it manually.
            findPageForFragment(fragment, this.frame);
        }
    },

    onStart: function () {
        this.super.onStart();
        trace.write("NativeScriptActivity.onStart();", trace.categories.NativeLifecycle);
        if (!this.frame.isLoaded) {
            this.frame.onLoaded();
        }
    },

    onStop: function () {
        this.super.onStop();
        trace.write("NativeScriptActivity.onStop();", trace.categories.NativeLifecycle);
        this.frame.onUnloaded();
    },

    onDestroy: function () {
        // TODO: Implement uninitialized(detached) routine
        var frame = this.frame;
        frame._onDetached(true);

        // There might be cached pages in the backstack - force detach them too.
        for (var i = 0; i < frame.backStack.length; i++) {
            frame.backStack[i].resolvedPage._onDetached(true);
        }

        this.androidFrame.reset();

        this.super.onDestroy();
        trace.write("NativeScriptActivity.onDestroy();", trace.categories.NativeLifecycle);
    },

    onOptionsItemSelected: function (menuItem: android.view.IMenuItem) {
        if (!this.androidFrame.hasListeners(frameCommon.Frame.androidOptionSelectedEvent)) {
            return false;
        }

        var data: definition.AndroidOptionEventData = {
            handled: false,
            eventName: frameCommon.Frame.androidOptionSelectedEvent,
            item: menuItem,
            object: this.androidFrame
        }

        this.androidFrame.notify(data);
        return data.handled;
    },

    onBackPressed: function () {
        trace.write("NativeScriptActivity.onBackPressed;", trace.categories.NativeLifecycle);

        var args = <application.AndroidActivityBackPressedEventData>{
            eventName: "activityBackPressed",
            object: application.android,
            activity: this,
            cancel: false,
        };
        application.android.notify(args);

        if (args.cancel) {
            return;
        }

        if (!frameCommon.goBack()) {
            this.super.onBackPressed();
        }
    },

    onLowMemory: function () {
        gc();
        java.lang.System.gc();
        this.super.onLowMemory();

        application.notify(<application.ApplicationEventData>{ eventName: application.lowMemoryEvent, object: this, android: this });
    },

    onTrimMemory: function (level: number) {
        gc();
        java.lang.System.gc();
        this.super.onTrimMemory(level);
    }
};

var framesCounter = 0;
var framesCache: Array<WeakRef<AndroidFrame>> = new Array<WeakRef<AndroidFrame>>();

class AndroidFrame extends observable.Observable implements definition.AndroidFrame {
    public rootViewGroup: android.view.ViewGroup;
    public hasOwnActivity = false;
    public frameId;

    private _showActionBar = true;
    private _activity: android.app.Activity;
    private _owner: Frame;
    private _cachePagesOnNavigate: boolean;

    constructor(owner: Frame) {
        super();
        this._owner = owner;
        this.frameId = framesCounter++;
        framesCache.push(new WeakRef(this));
    }

    public get showActionBar(): boolean {
        return this._showActionBar;
    }

    public set showActionBar(value: boolean) {
        if (this._showActionBar !== value) {
            this._showActionBar = value;
            if (this.owner.currentPage) {
                this.owner.currentPage.actionBar.update();
            }
        }
    }

    public get activity(): android.app.Activity {
        if (this._activity) {
            return this._activity;
        }

        // traverse the parent chain for an ancestor Frame
        var currView = this._owner.parent;
        while (currView) {
            if (currView instanceof Frame) {
                return (<Frame>currView).android.activity;
            }

            currView = currView.parent;
        }

        return undefined;
    }

    public get actionBar(): android.app.ActionBar {
        var activity = this.currentActivity;
        if (!activity) {
            return undefined;
        }

        var bar = activity.getActionBar();
        if (!bar) {
            return undefined;
        }

        return bar;
    }

    public get currentActivity(): android.app.Activity {
        var activity = this.activity;
        if (activity) {
            return activity;
        }

        var stack = frameCommon.stack(),
            length = stack.length,
            i = length - 1,
            frame: definition.Frame;

        for (i; i >= 0; i--) {
            frame = stack[i];
            activity = frame.android.activity;
            if (activity) {
                return activity;
            }
        }

        return undefined;
    }

    public get owner(): Frame {
        return this._owner;
    }

    public get cachePagesOnNavigate(): boolean {
        return this._cachePagesOnNavigate;
    }

    public set cachePagesOnNavigate(value: boolean) {
        if (this._cachePagesOnNavigate !== value) {
            if (this._owner.backStack.length > 0) {
                throw new Error("Cannot set cachePagesOnNavigate if there are items in the back stack.");
            }

            this._cachePagesOnNavigate = value;
        }
    }

    public onActivityRequested(intent: android.content.Intent): Object {
        if (this.activity) {
            throw new Error("Frame already attached to an Activity");
        }

        intent.putExtra(INTENT_EXTRA, this.frameId);
        this.hasOwnActivity = true;
        return this.createActivity(intent);
    }

    public canGoBack() {
        if (!this._activity) {
            return false;
        }

        // can go back only if it is not the main one.
        return this._activity.getIntent().getAction() !== android.content.Intent.ACTION_MAIN;
    }

    public reset() {
        // TODO: Cleanup, do we need more?
        delete this.rootViewGroup[OWNER];
        this._activity = undefined;
        this.rootViewGroup = undefined;
    }

    public setActivity(value: android.app.Activity) {
        this._activity = value;
    }

    private createActivity(intent: android.content.Intent) {
        // TODO: check intent
        return NativeActivity;
    }
}

function findPageForFragment(fragment: android.app.Fragment, frame: Frame) {
    var fragmentTag = fragment.getTag();
    var page: pages.Page;
    var entry: definition.BackstackEntry;

    trace.write("Attached fragment with no page: " + fragmentTag, trace.categories.NativeLifecycle);
    if (frame.currentPage && frame.currentPage[TAG] === fragmentTag) {
        page = frame.currentPage;
        entry = frame._currentEntry;
        trace.write("Current page matches fragment: " + fragmentTag, trace.categories.NativeLifecycle);
    }
    else {
        var backStack = frame.backStack;
        for (var i = 0; i < backStack.length; i++) {
            entry = backStack[i];
            if (backStack[i].resolvedPage[TAG] === fragmentTag) {
                entry = backStack[i];
                break;
            }
        }
        if (entry) {
            trace.write("Found entry:" + entry + " for fragment: " + fragmentTag, trace.categories.NativeLifecycle);
            page = entry.resolvedPage;
        }
    }
    if (page) {
        (<any>fragment).frame = frame;
        (<any>fragment).entry = entry;

        page[TAG] = fragmentTag;
    }
    else {
        //throw new Error("Could not find Page for Fragment.");
    }
}

function startActivity(activity: android.app.Activity, entry: definition.NavigationEntry) {
    var intent = new android.content.Intent(activity, (<any>com).tns.NativeScriptActivity.class);
    intent.setAction(android.content.Intent.ACTION_DEFAULT);
    // TODO: Put the navigation context (if any) in the intent
    activity.startActivity(intent);
}