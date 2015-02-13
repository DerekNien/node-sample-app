/**
 * 
 */
"use strict";

var NoGapDef = require('nogap').Def;

module.exports = NoGapDef.component({

    /**
     * Everything defined in `Host` lives only on the host side (Node).
     */
    Host: NoGapDef.defHost(function(Shared, Context) { return {
        Assets: {
            Files: {
                string: {
                    template: 'VideoPage.html'
                }
            },
            AutoIncludes: {
            }
        },
                
        /**
         * 
         */
        initHost: function() {
            
        },
        
        /**
         * Host commands can be directly called by the client
         */
        Public: {
            
        },
    }}),
    
    
    /**
     * Everything defined in `Client` lives only in the client (browser).
     */
    Client: NoGapDef.defClient(function(Tools, Instance, Context) {
        var ThisInstance;

        return {
            __ctor: function() {
                ThisInstance = this;
            },

            /**
             * Prepares the video page controller.
             */
            setupUI: function(UIMgr, app) {
                // create Video controller
                app.lazyController('videoCtrl', function($scope) {
                    UIMgr.registerPageScope(ThisInstance, $scope);
                    $scope.videoId = 'M7lc1UVf-VE';
                });

                // register page
                Instance.UIMgr.registerPage(this, 'Video', this.assets.template, {
                    cssClasses: 'fa fa-video-camera'
                });
            },
            
            /**
             * Client commands can be directly called by the host
             */
            Public: {
                
            }
        };
    })
});