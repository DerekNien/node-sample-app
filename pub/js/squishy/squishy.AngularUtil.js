(function() {
	/**
	 * Members to be added to Angular $scopes.
	 */
	var ScopeMembers = {
	    /**
	     * Call $scope.$apply(fn), if it is safe to do so
	     *  (i.e. digest or apply cycle is currently not executing).
	     */
	    safeDigest: function(fn) {
	    	if (!this.$root) return;		// scope has been destroyed

	        var phase = this.$root.$$phase;
	        if(phase == '$apply' || phase == '$digest') {
	            if(fn && (fn instanceof Function)) {
	                fn();
	            }
	        } else {
	            this.$digest(fn);
	            //this.digestAndMeasure(fn);
	        }
	    },

        /**
         * @see http://stackoverflow.com/a/23066423/2228771
         */
	    applyAndMeasure: function(fn) {
	    	var startTime = performance.now();
	    	this.$apply(fn); 
	    	console.log(performance.now() - startTime);
	    },

        /**
         * @see http://stackoverflow.com/a/23066423/2228771
         */
	    digestAndMeasure: function(fn) {
	    	var startTime = performance.now();
	    	this.$digest(fn); 
	    	console.log(performance.now() - startTime);
	    },

	    /**
	     * Uses `$scope.$watch` to track `$attrs[attrName]`.
	     * Also, if given, calls cb if the given attribute value changed.
	     */
	    bindAttrExpression: function($attrs, attrName, cb) {
	        // bind to the given attribute
	        this.$watch($attrs[attrName], function(newVal) {
	            // expression value changed -> update scope
	            this[attrName] = newVal;
	            if (cb) {
	                cb(newVal);
	            }
	        }.bind(this));
	    },

	    /**
	     * Uses `$attrs.$observe(attrName, ...)` to track changes to given attribute and update
	     * the corresponding value in $scope.
	     */
	    bindAttrValue: function($attrs, attrName, cb) {
	        // bind to the given attribute
	        $attrs.$observe(attrName, function(newVal) {
	            // evaluate the attribute expression and update the scope
	            this[attrName] = newVal;
	            if (cb) {
	                cb(newVal);
	            }
	        }.bind(this));
	    },

	    handleError: function(err) {
	    	console.error(err && err.stack || err);
	    	this.onError(err);
	    },

	    /**
	     * Default error event handling -> Save to $scope.errorMessage and run digest cycle
	     */
	    onError: function(err) {
	    	this.errorMessage = (err && err.message) || err;
	    	this.safeDigest();
	    },

	    clearError: function() {
	    	this.errorMessage = null;
	    }
	};


	squishy.getGlobalContext().AngularUtil = {
        decorateScope: function($scope) {
        	if ($scope.___decorated) return;
        	Object.defineProperty($scope, '___decorated', {
        		value: 1
        	});

        	// add AngularUtility functions to $scope and bind them
        	for (var memberName in ScopeMembers) {
        		var member = ScopeMembers[memberName];

        		if ($scope[memberName]) return;

        		// bind and add to scope
        		$scope[memberName] = member;
        	}
        }
    };
})();