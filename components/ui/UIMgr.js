/**
 * The UI Manager component:
 *  - Takes care of `Page` and `UIComponent` registration
 * 	- Keeps the address bar up to date
 *  - Handles all kinds of other aspects of navigation and the app frontend skeleton
 */
"use strict";

var NoGapDef = require('nogap').Def;



module.exports = NoGapDef.component({
    Namespace: 'bjt',
    
    Host: NoGapDef.defHost(function(Shared, Context) {
        return {
            Assets: {
                AutoIncludes: {
                    js: [
                        // jQuery
                        'lib/jquery/jquery-2.1.0.min.js',

                        // Angular JS
                        // 'lib/angular/angular.min.js',
                        // 'lib/angular/angular-sanitize.min.js',
                        'lib/angular/angular.js',
                        'lib/angular/angular-sanitize.js',
                    ]
                },

                Files: {
                    string: {
                        // UI mgr template
                        template: 'uimgr.html'
                    }
                }
            },

            Private: {
                onClientBootstrap: function() {
                    
                },
            }
        };
    }),
    

    
    Client: NoGapDef.defClient(function(Tools, Instance, Context) {

        // ####################################################################################################################
        // misc variables

        var scope, menuScope;

        // buttons in the main menu
        var navButtons = [];

        // current state info
        var activePage, activeButton;

        // page containers
        var pages = [];
        var pagesByPageName = {};
        var pagesByComponentName = {};

        // page group containers
        var pageGroups = [];
        var pageGroupsByComponentName = {};

        // misc vars
        var templateCache;
        var clientInitialized;

        /**
         * The main Angular module
         */
        var app;

        // ####################################################################################################################
        // Handle navigation (private)

        /**
         * Recursively call `onPageDeactivate` on component and all children.
         */
        var callOnPageDeactivateOnComponent = function(component, newPage) {
            var onPageDeactivateCb = component.onPageDeactivate;
            if (onPageDeactivateCb instanceof Function) {
                onPageDeactivateCb(newPage);
            }
            else if (onPageDeactivateCb && onPageDeactivateCb.pre) {
                // `onPageDeactivate` is an object with optional `pre` and `post` properties
                onPageDeactivateCb.pre.call(component, newPage);
            }

            // recursively call `onPageDeactivate` on children
            component.forEachPageChild(function(childComponent) {
                callOnPageDeactivateOnComponent(childComponent, newPage);
            });

            if (onPageDeactivateCb && onPageDeactivateCb.post) {
                // `onPageDeactivate` is an object with optional `pre` and `post` properties
                onPageDeactivateCb.post.call(component, newPage);
            }
        };

        var onPageDeactivate = function(page, newPage) {
            // fire event
            callOnPageDeactivateOnComponent(page.component, newPage);

            page.active = false;
            if (page.navButton) {
                page.navButton.active = false;
            }
        };


        /**
         * Recursively call `onPageActivate` on component and all children.
         */
        var callOnPageActivateOnComponent = function(component, pageArgs) {
            var onPageActivateCb = component.onPageActivate;
            if (onPageActivateCb instanceof Function) {
                onPageActivateCb.call(component, pageArgs);
            }
            else if (onPageActivateCb && onPageActivateCb.pre) {
                // `onPageActivate` is an object with optional `pre` and `post` properties
                onPageActivateCb.pre.call(component, pageArgs);
            }

            // recursively call `onPageActivate` on children
            component.forEachPageChild(function(childComponent) {
                callOnPageActivateOnComponent(childComponent, pageArgs);
            });

            if (onPageActivateCb && onPageActivateCb.post) {
                // `onPageActivate` is an object with optional `pre` and `post` properties
                onPageActivateCb.post.call(component, pageArgs);
            }
        };
        
        var onPageActivate = function(page, pageArgs) {
            // set activePage
            activePage = page;

            // update title
            var pageTitle = page.getTitle ? page.getTitle() : page.name;
            document.title =  pageTitle + ' - ' + Instance.UIMgr.appName;

            // set active button:
            if (activeButton) {
                // only one active button in the main menu (for now)
                activeButton.active = false;
            }
            page.active = true;
            if (page.navButton) {
                page.navButton.active = true;
                activeButton = page.navButton;
            }
            else if (page.parentPageName) {
                // TODO: Make this more consistent
                var parentPage = pagesByPageName[page.parentPageName];
                parentPage.navButton.active = true;
                activeButton = parentPage.navButton;
            }
            
            // add history entry
            Instance.UIMgr.updateAddressBar(page.component, pageArgs, true);
            
            // re-compute arguments
            pageArgs = pageArgs || (page.component.getPageArgs && page.component.getPageArgs());

            callOnPageActivateOnComponent(page.component, pageArgs);
        };
                
        /**
         * Deactivate current and activate new page.
         */
        var setActivePage = function(newPage, pageArgs, force) {
        	var This = Instance.UIMgr;

            // we need to defer setup because Angular might not be ready yet
            This.ready(function() {
                if (!force && activePage == newPage) {
                    // same page -> Don't do anything

                    // same page -> Only update address arguments
                    //Instance.UIMgr.updateAddressBar(newPage.component, pageArgs, true);
                }
                else {
                    if (activePage) {
                        // deactivate current page
                        var result = onPageDeactivate(activePage, newPage);
                        // if (result === false) {
                        //     // page change was cancelled
                        //     return;
                        // }
                    }
                    if (!newPage) {
                        // nothing happens (should probably never happen)
                        activePage = null;
                    }
                    else {
                        // activate new page
                        onPageActivate(newPage, pageArgs);
                    }

                    // invalid view
                    scope.safeApply();

                    // fire event
                    This.events.pageActivated.fire(newPage);
                }
            });
        };

        return {

            // ################################################################################################################
            // UIMgr initialization

            __ctor: function() {
                // setup event stuff
                this.readyCount = 0;
                this.expectedReadyCount = 1;

            	this.events = {
                    ready: squishy.createEvent(this),
            		pageActivated: squishy.createEvent(this)
            	};
            },
            
            /**
             * This is called by the outside to kickstart this whole thing.
             */
            initUIMgr: function(appName, includeModules, onControllerCreation) {
            	console.assert(!clientInitialized, 'Tried to initialize UIMgr more than once.');
                clientInitialized = true;
                this.appName = appName;

                // Angular setup
                // Added modules: 
                //  - 'ui.bootstrap' (http://angular-ui.github.io/bootstrap/)
                app = angular.module('app', includeModules || []);

                // define lazy version as non-lazy version first.
                // Once ready + bootstrapped, they will be overridden with the actual lazy version of things.
                // This way, we can always use these, no matter Angular's state.
                app.lazyController = app.controller.bind(app);
                app.lazyDirective = app.directive.bind(app);

                app.
                config(['$controllerProvider', '$compileProvider', 
                    function($controllerProvider, $compileProvider) {

                    // we need this for lazy registration of new controllers after Angular's bootstrap
                    // Example - see: http://jsfiddle.net/8Bf8m/33/
                    // API - see: https://docs.angularjs.org/api/ng/provider/$controllerProvider
                    //app.lazyController = $controllerProvider.register;
                    app.lazyController = function(name) {
                        //console.log('Creating controller: ' + name);
                        $controllerProvider.register.apply($controllerProvider, arguments);
                    };

                    // we need this for lazy registration of new directives after Angular's bootstrap
                    // see: http://stackoverflow.com/a/24228135/2228771
                    app.lazyDirective = $compileProvider.directive;

                    // app.lazyController = function(ctrlName, ctorDIArray) {
                    //     console.assert(ctorDIArray instanceof Array), 
                    //         'The second argument to `lazyController` must be a ctor in array form, decorated with DI annotations.');
                        
                    //     // we are still waiting for this guy
                    //     ++this.expectedReadyCount;

                    //     var isReady;

                    //     // add $injector, so we can get a grip on when this ctor was created
                    //     var iCtor = ctorDIArray.length-1;
                    //     var ctor = ctorDIArray[iCtor];
                    //     console.assert(ctor instanceof Function, 
                    //         'Invalid constructor. The last element in the array handed to `lazyController` must be a ctor function.');

                    //     // inject ready maker
                    //     ctorDIArray[iCtor] = function() {
                    //         // call original ctor
                    //         ctor.apply(this, arguments);

                    //         // 
                    //         var $injector = arguments[arguments.length-1];

                    //         // ctor was invoked -> We are now (probably) ready.
                    //         if (!isReady) {
                    //             isReady = true;
                    //             signalReady();
                    //         }
                    //     };

                    //     ctorDIArray.splice(nDeps, 0, "$injector");
                    //     $controllerProvider.register(ctrlName, ctorDIArray);
                    // }.bind(this);

                    // TODO: Inject a callback for guessing ready state

                }]).
                config( ['$provide', function ($provide){
                    $provide.decorator('$browser', ['$delegate', function ($delegate) {
                        // Turn off the awful location service...
                        // This awfully badly written piece of software makes it impossible to use the standard browsing features and introduces random bugs...
                        // see: http://stackoverflow.com/questions/18611214/turn-off-url-manipulation-in-angularjs
                        $delegate.onUrlChange = function () {};
                        $delegate.url = function () { return ""; };
                        return $delegate;
                    }]);
                }]);
                
                // define root controller
                var This = this;
                app.controller('uimgrCtrl',
                    ['$scope', '$templateCache', '$injector',  '$modal', '$rootScope',
                    function($scope, $templateCache, $injector, $modal, $rootScope) {
                        AngularUtil.decorateScope($scope);

                        // add pages to main scope
                        $scope.pages = pages;

                        // add some useful functions to everyone's scope:
                        $scope.gotoPage = This.gotoPage.bind(This);

                        // remember $scope & $templateCache so we can lazily add partials
                        scope = This.scope = $scope;
                        templateCache = $templateCache;

                        // add some general UI tools to the UIMgr scope
                        // see: http://stackoverflow.com/questions/13845409/angularjs-default-text-for-empty-ng-repeat-on-javascript-object
                        $scope.isEmptyObject = function (obj) {
                            return angular.equals({},obj); 
                        };

                        // prepare OK<->Cancel Modal
                        // see: http://angular-ui.github.io/bootstrap/#modal
                        $scope.okCancelModal = function (size, title, body, onOk, onDismiss) {
                            var modalInstance = $modal.open({
                                templateUrl: 'okCancelModal.html',
                                size: size,
                                resolve: {
                                    items: function () {
                                    }
                                },
                                controller: function ($scope, $modalInstance, items) {
                                    $scope.okCancelModalData = {
                                        title: title,
                                        body: body
                                    };
                                    $scope.ok = function () {
                                        $modalInstance.close('ok');
                                    };

                                    $scope.cancel = function () {
                                        $modalInstance.dismiss('cancel');
                                    };
                                }
                            });

                            modalInstance.result.then(onOk, onDismiss);
                        };

                        // call controller creation hook, if one was supplied
                        if (onControllerCreation) {
                            onControllerCreation();
                        }

                        $injector.invoke(function() {
                            // basic UI initialized
                            This.signalReady();
                        });
                    }]);

                app.controller('uiMenuCtrl', 
                    ['$scope', '$templateCache', '$injector',  '$modal', '$rootScope',
                    function($scope) {
                        AngularUtil.decorateScope($scope);
                        menuScope = This.menuScope = $scope;
                        $scope.navButtons = navButtons;
                    }]);

	            // handle back button and manual browsing:
	            window.onpopstate = function() {
	                // go given address
                    if (!this.addedHistoryEntry) return;

                    // TODO: This still doesn't work right
                    this.lastAddress = history.state;
	                this.gotoAddressBarAddress();
	            }.bind(this);
                
                // add the view to the body
                // this will also bootstrap our angular app
                document.body.innerHTML += this.assets.template;

                // return app object
                return app;
            },

            // ################################################################################################################
            // Manage UIMgr ready state

            signalNotReady: function() {
                ++this.expectedReadyCount;

                // manage a timer for debugging purposes
                if (this.signalTimeoutTimer) {
                    // clear old timer
                    clearTimeout(this.signalTimeoutTimer);
                }
                if (this.expectedReadyCount != this.readyCount) {
                    // start new timer
                    var debugTimeout = 3000;
                    var oldExpectedReadyCount = this.expectedReadyCount
                    var oldReadyCount = this.readyCount;
                    this.signalTimeoutTimer = setTimeout(function() {
                        if (this.expectedReadyCount == oldExpectedReadyCount &&
                            this.readyCount == oldReadyCount) {
                            console.error('UIMgr seems deadlocked. Make sure that your ' +
                                '`signalNotReady` calls are always paired with `signalReady` calls. ' +
                                'Also make sure that your `signalReady` calls can always be reached ' +
                                'and are only called once.');
                        }
                    }.bind(this), debugTimeout);
                }
            },

            signalReady: function() {
                ++this.readyCount;
                if (this.readyCount == this.expectedReadyCount) {
                    setTimeout(function() {
                        this.events.ready.fire();

                        // we are ready now:
                        // remove all previously registered listeners
                        this.events.ready = new squishy.createEvent();
                    }.bind(this));
                }
            },

            /**
             * Calls the given cb either after the UI is ready, 
             * or right away if it is already ready.
             */
            ready: function(cb) {
                //console.log(this.readyCount +' / ' + this.expectedReadyCount)
                if (this.expectedReadyCount != this.readyCount) {
                    this.events.ready.addListener(cb);
                }
                else {
                    cb.call(this);
                }
            },


            // ################################################################################################################
            // Add page groups, pages, buttons, templates etc.

            addPageGroup: function(group) {
                console.assert(group.mayActivate, 'Page group must define a `mayActivate` method.');
                console.assert(group.pageComponents, 'Page group must define a `pageComponents` array.');

                // merge `pageComponents` and `otherComponents` into `allComponents`
                // start with `otherComponents` (non-UI components), so they are loaded first
                group.allComponents = group.otherComponents ? group.otherComponents.concat(group.pageComponents) : group.pageComponents;

                group.pages = [];
                pageGroups.push(group);
                group.pageComponents.forEach(function(componentName) {
                    pageGroupsByComponentName[componentName] = group;
                }.bind(this));
            },

            /**
             * Add new content to the main container on the page
             */
            addPage: function(component, pageName, content, buttonClass, parentPageName) {
                var This = this;

                console.assert(!pagesByPageName[pageName], 'Page name already exists. Currently, page names must be unique');

                var componentName = component._def.FullName;
                var group = pageGroupsByComponentName[componentName];

                console.assert(group, 'Page was not in any group - We need groups to determine what to load and when: ' + pageName);

                var page = {
                    name: pageName,
                    templateName: 'page/' + pageName,
                    content: content,
                    component: component,
                    group: group,
                    parentPageName: parentPageName,
                    active: false,

                    toString: function() { return this.name; }
                };

                // add parent<->child Association
                if (parentPageName) {
                    var parentPage = pagesByPageName[parentPageName];
                    if (!parentPage) {
                        throw new Error('Could not find parent page `' + parentPageName + '` for page `' + pageName + 
                            '`. Make sure that the parent page exists and that it is loaded before the child page (order matters!).');
                    }
                    page.parent = parentPage;
                    parentPage.children = parentPage.children || {};
                    parentPage.children[pageName] = page;
                }

                // patch component page object:
                // add `page` property
                component.page = page;

                // add `activatePage` method
                Object.defineProperty(component, 'activatePage', {
                    enumerable: true,

                    value: function(force) {
                        setActivePage(page, null, force);
                    }
                });


                // add page to all containers and to group
                pages.push(page);
                pagesByPageName[pageName] = page;
                pagesByComponentName[componentName] = page;
                group.pages.push(page);

                // TODO: Justified nav
                //          (http://stackoverflow.com/questions/14601425/bootstrap-navbar-justify-span-menu-items-occupying-full-width)
                //          (http://getbootstrap.com/examples/justified-nav/)

                // handle button
                if (buttonClass) {
                    // add nav button
                    var button = {
                        name: pageName,
                        pageName: pageName,
                        cssClass: buttonClass,
                        show: true,
                        //tabindex: navButtons.length+1,
                        onClick: function() {
                            This.onNavButtonClick(pageName);
                        },

                        // TODO: Generalize below customizations

                        // urgent marker
                        urgentMarker: false,
                        setUrgentMarker: function(enabled) {
                            this.urgentMarker = enabled;

                            // refresh menu
                            menuScope.safeApply();
                        },

                        // badge value
                        badgeValue: 0
                    };

                    page.navButton = button;
                    navButtons.push(button);
                }

                this.addTemplate(page.templateName, content);
            },

            /**
             * Partial templates allow us to lazy-load templates in string form.
             * @see http://jsfiddle.net/8Bf8m/33/
             */
            addTemplate: function(templateName, content) {
                console.assert(templateName && content, 'Invalid template data');
                templateCache.put(templateName, content);
            },

            // ################################################################################################################
            // Some Events
            
            /**
             * Called after the given component has been freshly loaded to the client.
             */
            onNewComponent: function(newComponent) {
                // call `setupUI` on ui components
                //console.log('comp ' + newComponent._def.FullName + ' ' + !!newComponent.setupUI);
                if (newComponent.setupUI) {
                    newComponent.setupUI(this, app);

                    // flag as UI newComponent
                    newComponent.isUI = true;
                }

                // hook-up all component events
                if (newComponent.componentEventHandlers) {
                    // iterate over all component event handlers
                    for (var componentName in newComponent.componentEventHandlers) {
                        var dependency = newComponent.componentEventHandlers[componentName];
                        var otherComponent = Instance[componentName];
                        console.assert(otherComponent, 'Invalid entry in `' + newComponent._def.FullName + 
                            '.componentEventHandlers`: Component `' + componentName + '` does not exist.');


                        var events = otherComponent.events;
                        console.assert(events, 'Invalid entry in `' + newComponent._def.FullName + 
                            '.componentEventHandlers`: Component `' + componentName + '` does not define any events.');


                        for (var eventName in dependency) {
                            // get callback function
                            var callback = dependency[eventName];
                            console.assert(callback instanceof Function, 'Invalid entry in `' + newComponent._def.FullName + 
                                '.componentEventHandlers`: Entry `' + eventName + '` is not a function.');

                            // get event
                            var evt = events[eventName];
                            console.assert(evt, 'Invalid entry in `' + newComponent._def.FullName + 
                                '.componentEventHandlers`: Component `' + componentName + '` does not define `events.' + eventName + '` property.');

                            // hook up callback function to the event
                            evt.addListener(callback);
                        }
                    }
                }
            },

            /** 
             * Tie in new components after they have all been initialized.
             */
            onNewComponents: function(newComponents) {
                // Tie in UI components with their child UI components

                // iterate over all new components
                for (var i = 0; i < newComponents.length; i++) {
                    var component = newComponents[i];

                    // convinient page child iteration method
                    component.forEachPageChild = function(fn) {
                        if (!this.PageChildren) return;

                        for (var i = 0; i < this.PageChildren.length; ++i) {
                            var childName = this.PageChildren[i];
                            var childComponent = Instance[childName];
                            if (!childComponent) {
                                throw new Error('Invalid entry "' + childName + 
                                    '" in `PageChildren` of component "' + component + '". ' +
                                    "Child component does not exist or has not been loaded yet.");
                            }

                            fn(childComponent);
                        };
                    };

                    // initialize Page child <-> parent relation
                    component.forEachPageChild(function(childComponent) {
                        // Don't do this, since a child might have multiple parents
                        //// set parent
                        //childComponent.parentComponent = component;

                        // mark as UI component
                        childComponent.isUI = 1;
                    });
                };

                if (scope) {
                    scope.safeApply();
                }
            },

            onNavButtonClick: function(pageName) {
                this.gotoPage(pageName);
            },

            /**
             * Display current page location in address bar (and add history entry).
             * Does not do anything if the given component is not the active page and `force` is `false`.
             */
            updateAddressBar: function(component, pageArgs, force) {
                if (force || (activePage && activePage.component == component)) {
                    // build base path from path in page tree
                    var pagePath = this.getPageBasePath(activePage);

                    // get pageArgs
                    pageArgs = pageArgs || (component.getPageArgs && component.getPageArgs()) || '';
                    if (pageArgs) {
                        pagePath += '/' + pageArgs;
                    }

                    var lowerCasePagePath = pagePath.toLowerCase();

                    if (!history.state) {
                        // first entry
                        history.replaceState(pagePath, null, pagePath);
                    }
                    else if (history.state.toLowerCase() !== lowerCasePagePath &&
                        this.lastAddress !== lowerCasePagePath) {
                        // only add history entry if it's different from the last one (case-insensitively)
                        history.pushState(pagePath, null, pagePath);
                    }
                    this.addedHistoryEntry = true;
                }
            },

            // ################################################################################################################
            // Events triggered directly by the server (or by client)

            /**
             * User privs changed ->
             * Re-validate which buttons and pages to show.
             */
            revalidatePagePermissions: function() {
                if (!clientInitialized) return;

                // Revalidate whether user is still allowed to see the current page or buttons
                for (var i = 0; i < pageGroups.length; ++i) {
                    var group = pageGroups[i];
                    for (var j = 0; j < group.pages.length; ++j) {
                        var page = group.pages[j];
                        if (page.navButton) {
                            page.navButton.show = group.mayActivate();
                        }
                    }
                }

                // navigate to where user wants to go
                this.gotoAddressBarAddress();
            },


            // ################################################################################################################
            // Goto & UIMgr (public API)

            /**
             * We leave the current page because we are not supposed to be on it.
             * In that case, we want to go back to the last page and remove the current page from the history.
             * However it is not possible to rewrite browser history (yet).
             * So we have to track everything ourselves.
             */
            leaveCurrentPage: function() {
                if (!activePage) return;

                // TODO: Track all history and enable deleting of entries and smarter navigation

                // for now, we just settle with the fact that the page is still in the history and go back
                //gotoPage('Home');
                history.back();
            },

            /**
             * Use a stupid heuristic to get component name from page name
             */
            getComponentNameFromPageName: function(pageName) {
                return pageName + 'Page';
            },

            /**
             * Recursively get full path of page in page tree.
             */
            getPageBasePath: function(currentPage) {
                var parentPage = currentPage.parent;
                var path = '/' + currentPage.name;
                if (parentPage) {
                    // recurse
                    path = this.getPageBasePath(parentPage) + path;
                }
                return path;
            },


            /**
             * Go to the state encoded in the current path of the address bar
             */
            gotoAddressBarAddress: function() {
                // get path
                //var path = window.location.href.substring(origin.length);
                var path = window.location.pathname + window.location.search
                     + window.location.hash;
                if (path.length > 0) {
                    path = path.substring(1);
                }
                if (path.length == 0) {
                    // go to default page
                    this.gotoDefaultPage();
                }
                else {
                    // decompose the location's `path` and go to the page
                    var pathObj = path.split('/');
                    var pageName;
                    var argsIdx = 0;
                    for (var i = 0; i < pathObj.length; ++i) {
                        var _pageName = pathObj[i];
                        while (_pageName.endsWith('#')) {
                            // sometimes, a hash steals itself into the name
                            _pageName = _pageName.substring(0, _pageName.length-1);
                        }
                        var componentName = this.getComponentNameFromPageName(_pageName);
                        if (!pageGroupsByComponentName[componentName]) {
                            // this is not a valid page name -> Probably an argument
                            break;
                        }
                        pageName = _pageName;
                        argsIdx += pageName.length + 1;
                    }

                    // get page args
                    var pageArgs = path.length > argsIdx ? path.substring(argsIdx) : null;

                    this.gotoPage(pageName, pageArgs);
                }
            },

            /**
             * Fallback page when user-selection is not valid.
             * WARNING: This code is fragile.
             *      If there is a small error in the routing logic, this call can easily cause an infinite loop.
             */
            gotoDefaultPage: function(lastTriedGroup) {
            	// go to first page of first allowed group
            	for (var i = 0; i < pageGroups.length; ++i) {
                    var group = pageGroups[i];
            		if (group.mayActivate()) {
                        if (group == lastTriedGroup) {
                            // failed to go to this page before
                            break;
                        }
            			this.gotoComponent(group.pageComponents[0]);
                        return;
            		}
            	};

                console.error('Could not go to default page.');
            },

            /**
             * Go to the page of the given name.
             */
            gotoPage: function(pageName, pageArgs) {
                this.gotoComponent(this.getComponentNameFromPageName(pageName), pageArgs);
            },
            
            /**
             * Prepare going to the page that is represented by the component of the given name.
             */
            gotoComponent: function(componentName, pageArgs) {
                // get all components of the same group
                var pageGroup = pageGroupsByComponentName[componentName];

                // check if component is page and whether user has required access rights
                if (!pageGroup || !pageGroup.mayActivate()) {
                    // cannot access -> go to fallback page
                    this.gotoDefaultPage();
                    return;
                }

                // request the given (and all other missing) components from server
                // we merge all allowed groups' components together
                // This is for example for admins so they can see the `Admin` page even if they
                // only requested the `Home` page for now.
                var groupComponents = [];
                pageGroups.forEach(function(pageGroup) {
                    if (pageGroup.mayActivate()) {
                        groupComponents.push.apply(groupComponents, pageGroup.allComponents);
                    }
                });

                return Tools.requestClientComponents(groupComponents)
                .then(function() {
                    console.assert(pages.length, 
                        'Tried to goto page `' + componentName + '` when there was no page registered.');

                    //var comp = this.Instance[componentName];

                    // now check if it's actually a page (component must be present for this check)
                    if (pagesByComponentName[componentName]) {
                        // activate it
                        setActivePage(pagesByComponentName[componentName], pageArgs, true);
                    }
                    else {
                        // fall back to default
                        this.gotoDefaultPage(pageGroup);
                    }
                //}.bind(this));}.bind(this));
                }.bind(this));
                //}.bind(this));
            },


            Public: {
            }
        };
    })
});