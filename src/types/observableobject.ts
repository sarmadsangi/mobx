import {ObservableValue, UNCHANGED} from "./observablevalue";
import {ComputedValue} from "../core/computedvalue";
import {isAction} from "../api/action";
import {ValueMode, AsStructure} from "./modifiers";
import {Lambda, getNextId, invariant, assertPropertyConfigurable, isPlainObject, addHiddenFinalProp} from "../utils/utils";
import {runLazyInitializers} from "../utils/decorators";
import {hasInterceptors, IInterceptable, registerInterceptor, interceptChange} from "./intercept-utils";
import {IListenable, registerListener, hasListeners, notifyListeners} from "./listen-utils";
import {isSpyEnabled, spyReportStart, spyReportEnd} from "../core/spy";

// In 3.0, change to IObjectDidChange
export interface IObjectChange {
	name: string;
	object: any;
	type: "update" | "add";
	oldValue?: any;
	newValue: any;
}

export interface IObjectWillChange {
	object: any;
	type: "update" | "add";
	name: string;
	newValue: any;
}

export class ObservableObjectAdministration implements IInterceptable<IObjectWillChange>, IListenable {
	values: {[key: string]: ObservableValue<any>|ComputedValue<any>} = {};
	changeListeners = null;
	interceptors = null;

	constructor(public target: any, public name: string, public mode: ValueMode) { }

	/**
		* Observes this object. Triggers for the events 'add', 'update' and 'delete'.
		* See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/observe
		* for callback details
		*/
	observe(callback: (changes: IObjectChange) => void, fireImmediately?: boolean): Lambda {
		invariant(fireImmediately !== true, "`observe` doesn't support the fire immediately property for observable objects.");
		return registerListener(this, callback);
	}


	intercept(handler): Lambda {
		return registerInterceptor(this, handler);
	}
}

export interface IIsObservableObject {
	$mobx: ObservableObjectAdministration;
}

export function asObservableObject(target, name: string, mode: ValueMode = ValueMode.Recursive): ObservableObjectAdministration {
	if (isObservableObject(target))
		return target.$mobx;

	if (!isPlainObject(target))
		name = target.constructor.name + "@" + getNextId();
	if (!name)
		name = "ObservableObject@" + getNextId();

	const adm = new ObservableObjectAdministration(target, name, mode);
	addHiddenFinalProp(target, "$mobx", adm);
	return adm;
}

export function setObservableObjectInstanceProperty(adm: ObservableObjectAdministration, propName: string, value) {
	if (adm.values[propName])
		adm.target[propName] = value; // the property setter will make 'value' reactive if needed.
	else
		defineObservableProperty(adm, propName, value, true, undefined);
}

export function defineObservableProperty(adm: ObservableObjectAdministration, propName: string, newValue, asInstanceProperty: boolean, setter) {
	if (asInstanceProperty)
		assertPropertyConfigurable(adm.target, propName);

	let observable: ComputedValue<any>|ObservableValue<any>;
	let name = `${adm.name}.${propName}`;
	let isComputed = true;

	if (newValue instanceof ObservableValue) {
		observable = newValue;
		isComputed = false;
	} else if (newValue instanceof ComputedValue) {
		observable = newValue;
		if (!newValue.scope)
			newValue.scope = adm.target;
	} else if (typeof newValue === "function" && newValue.length === 0 && !isAction(newValue)) {
		// TODO: add warning in 2.6, see https://github.com/mobxjs/mobx/issues/421
		// TODO: remove in 3.0
		observable = new ComputedValue(newValue, adm.target, false, name, setter);
	} else if (newValue instanceof AsStructure && typeof newValue.value === "function" && newValue.value.length === 0) {
		observable = new ComputedValue(newValue.value, adm.target, true, name, setter);
	} else {
		isComputed = false;
		if (hasInterceptors(adm)) {
			const change = interceptChange<IObjectWillChange>(adm, {
				object: adm.target,
				name: propName,
				type: "add",
				newValue
			});
			if (!change)
				return;
			newValue = change.newValue;
		}
		observable = new ObservableValue(newValue, adm.mode, name, false);
		newValue = (observable as any).value; // observableValue might have changed it
	}

	adm.values[propName] = observable;
	if (asInstanceProperty) {
		Object.defineProperty(adm.target, propName, isComputed ? generateComputedPropConfig(propName) : generateObservablePropConfig(propName));
	}
	if (!isComputed)
		notifyPropertyAddition(adm, adm.target, propName, newValue);
}

const observablePropertyConfigs = {};
const computedPropertyConfigs = {};

export function generateObservablePropConfig(propName) {
	const config = observablePropertyConfigs[propName];
	if (config)
		return config;
	return observablePropertyConfigs[propName] = {
		configurable: true,
		enumerable: true,
		get: function() {
			return this.$mobx.values[propName].get();
		},
		set: function(v) {
			setPropertyValue(this, propName, v);
		}
	};
}

export function generateComputedPropConfig(propName) {
	const config = computedPropertyConfigs[propName];
	if (config)
		return config;
	return computedPropertyConfigs[propName] = {
		configurable: true,
		enumerable: false,
		get: function() {
			return this.$mobx.values[propName].get();
		},
		set: function(v) {
			return this.$mobx.values[propName].set(v);
		}
	};
}

export function setPropertyValue(instance, name: string, newValue) {
	const adm = instance.$mobx;
	const observable = adm.values[name];

	// intercept
	if (hasInterceptors(adm)) {
		const change = interceptChange<IObjectWillChange>(adm, {
			type: "update",
			object: instance,
			name, newValue
		});
		if (!change)
			return;
		newValue = change.newValue;
	}
	newValue = observable.prepareNewValue(newValue);

	// notify spy & observers
	if (newValue !== UNCHANGED) {
		const notify = hasListeners(adm);
		const notifySpy = isSpyEnabled();
		const change = notifyListeners || hasListeners ? {
				type: "update",
				object: instance,
				oldValue: (observable as any).value,
				name, newValue
			} : null;

		if (notifySpy)
			spyReportStart(change);
		observable.setNewValue(newValue);
		if (notify)
			notifyListeners(adm, change);
		if (notifySpy)
			spyReportEnd();
	}
}

function notifyPropertyAddition(adm, object, name: string, newValue) {
	const notify = hasListeners(adm);
	const notifySpy = isSpyEnabled();
	const change = notify || notifySpy ? {
			type: "add",
			object, name, newValue
		} : null;

	if (notifySpy)
		spyReportStart(change);
	if (notify)
		notifyListeners(adm, change);
	if (notifySpy)
		spyReportEnd();
}

export function isObservableObject(thing): boolean {
	if (typeof thing === "object" && thing !== null) {
		// Initializers run lazily when transpiling to babel, so make sure they are run...
		runLazyInitializers(thing);
		return thing.$mobx instanceof ObservableObjectAdministration;
	}
	return false;
}