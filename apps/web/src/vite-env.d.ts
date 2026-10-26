/// <reference types="vite/client" />
interface ImportMetaEnv { readonly VITE_EDITION: 'cloud' | 'onprem' }
interface ImportMeta { readonly env: ImportMetaEnv }
