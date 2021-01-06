// @flow
import type {REPLOptions, CodeMirrorDiagnostic} from '../utils';

import {ASSET_PRESETS, FS, join} from './assets';
import path from 'path';
import nullthrows from 'nullthrows';

export const DEFAULT_OPTIONS: REPLOptions = {
  entries: [],
  minify: false,
  scopeHoist: true,
  sourceMaps: false,
  publicUrl: '/__repl_dist',
  targetType: 'browsers',
  targetEnv: null,
  outputFormat: null,
  hmr: false,
  mode: 'production',
  renderGraphs: false,
  viewSourcemaps: false,
  dependencies: [],
};

export type State = {|
  currentView: number,
  files: FS,
  views: Map<string, {|value: string|} | {|component: any|}>,
  browserExpanded: Set<string>,
  isEditing: null | string,
  options: REPLOptions,
  useTabs: boolean,
  diagnostics: Map<string, Array<CodeMirrorDiagnostic>>,
|};

export const initialState: State = {
  currentView: 0,
  files: new FS(),
  views: new Map(),
  browserExpanded: new Set(),
  isEditing: null,
  options: DEFAULT_OPTIONS,
  useTabs: true,
  diagnostics: new Map(),
};

function loadPreset(name = 'Javascript') {
  let preset = nullthrows(ASSET_PRESETS.get(name));
  return {
    ...initialState,
    files: new FS(preset.fs),
    options: {
      ...initialState.options,
      ...preset.options,
    },
  };
}

export const getInitialState = (): State => {
  let loaded = loadState();
  if (loaded) return loaded;

  return loadPreset();
};

export function reducer(state: State, action: any): State {
  switch (action.type) {
    case 'view.select':
      return {...state, currentView: action.index};
    case 'view.open': {
      let views = new Map([
        ...state.views,
        [
          action.name,
          action.component
            ? {component: action.component}
            : {value: nullthrows(state.files.get(action.name)).value},
        ],
      ]);
      let viewIndex = [...views].findIndex(([n]) => n === action.name);
      return {
        ...state,
        views,
        currentView: viewIndex,
      };
    }
    case 'view.close':
      return {
        ...state,
        views: new Map([...state.views].filter(([n]) => n != action.name)),
      };
    case 'view.setValue': {
      let data = nullthrows(state.views.get(action.name));
      if (!data.value) {
        return state;
      }
      return {
        ...state,
        views: new Map([
          ...state.views,
          [action.name, {...data, value: action.value}],
        ]),
      };
    }
    case 'view.saveCurrent': {
      if (state.useTabs) {
        let [name, view] = [...state.views][state.currentView];
        if (view.value == null) return state;

        let value = view.value;
        let file = nullthrows(state.files.get(name));
        if (file.value === value) return state;

        return {
          ...state,
          files: state.files.setMerge(name, {value}),
        };
      } else {
        let files = state.files;
        for (let [name, view] of state.views) {
          if (view.value == null) {
            continue;
          }
          // $FlowFixMe
          let value = view.value;
          let file = nullthrows(state.files.get(name));
          if (file.value === value) {
            continue;
          }
          files = files.setMerge(name, {value});
        }
        if (files === state.files) return state;

        return {
          ...state,
          files,
        };
      }
    }
    case 'view.closeCurrent':
      return {
        ...state,
        views: new Map(
          [...state.views].filter((_, i) => i !== state.currentView),
        ),
      };

    case 'file.move': {
      let oldName = action.name;
      let newName = join(action.dir, path.basename(action.name));
      console.log(
        state.browserExpanded,
        new Set(
          [...state.browserExpanded].map(f =>
            f === action.name ? newName : f,
          ),
        ),
      );
      return {
        ...state,
        files: state.files.move(oldName, newName),
        browserExpanded: new Set(
          [...state.browserExpanded].map(f =>
            f === action.name ? newName : f,
          ),
        ),
        views: new Map(
          [...state.views].map(([name, data]) => [
            name === oldName ? newName : name,
            data,
          ]),
        ),
      };
    }
    case 'file.delete':
      return {
        ...state,
        files: state.files.delete(action.name),
        views: new Map(
          [...state.views].filter(([name]) => !name.startsWith(action.name)),
        ),
      };
    case 'file.addFile': {
      let i = 1;
      while (state.files.has(`/file${i}.js`)) {
        i++;
      }
      return {
        ...state,
        files: state.files.set(`/file${i}.js`, {value: ''}),
      };
    }
    case 'file.addFolder': {
      let i = 1;
      while (state.files.has(`/folder${i}`)) {
        i++;
      }
      return {
        ...state,
        files: state.files.set(`/folder${i}`, new Map()),
      };
    }
    case 'file.isEntry': {
      return {
        ...state,
        files: state.files.setMerge(action.name, {isEntry: action.value}),
      };
    }
    case 'browser.expandToggle': {
      return {
        ...state,
        browserExpanded: state.browserExpanded.has(action.name)
          ? new Set([...state.browserExpanded].filter(n => n != action.name))
          : new Set([...state.browserExpanded, action.name]),
      };
    }
    case 'browser.setEditing': {
      if (state.isEditing != null && action.name == null) {
        let oldName = state.isEditing;
        let newName = join(path.dirname(state.isEditing), action.value);
        state = {
          ...state,
          files: state.files.move(oldName, newName),
          browserExpanded: new Set(
            [...state.browserExpanded].map(f => (f === oldName ? newName : f)),
          ),
          views: new Map(
            [...state.views].map(([name, data]) => [
              name === oldName ? newName : name,
              data,
            ]),
          ),
        };
      }
      return {
        ...state,
        isEditing: action.name || null,
      };
    }
    case 'preset.load':
      return loadPreset(action.name);
    case 'options':
      return {
        ...state,
        options: {
          ...state.options,
          [action.name]: action.value,
        },
      };
    case 'toggleView':
      return {
        ...state,
        useTabs: !state.useTabs,
      };
    case 'diagnostics': {
      return {
        ...state,
        diagnostics: action.value ?? new Map(),
      };
    }
    default:
      throw new Error();
  }
}

export function saveState(state: State) {
  let data = {
    files: state.files.toJSON(),
    options: state.options,
    useTabs: state.useTabs,
    browserExpanded: [...state.browserExpanded],
    views: [...state.views.keys()],
    currentView: state.currentView,
  };

  window.location.hash = btoa(encodeURIComponent(JSON.stringify(data)));
}

export function loadState(): ?State {
  const hash = window.location.hash.replace(/^#/, '');

  try {
    const data = JSON.parse(decodeURIComponent(atob(hash)));

    const files = FS.fromJSON(data.files);
    return {
      ...initialState,
      files,
      views: new Map(
        data.views
          .map(name => [name, files.get(name)])
          .filter(([, data]) => data),
      ),
      options: data.options,
      useTabs: data.useTabs,
      currentView: data.currentView,
      browserExpanded: new Set(data.browserExpanded),
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    window.location.hash = '';
    return null;
  }
}
