export const LOCAL_STORAGE_KEYS = {
    PROFILE: "formstr-drive-profile",
    CUSTOM_FOLDERS: "formstr-drive-custom-folders",
    THEME: "formstr-drive-theme",
    PALETTE: "formstr-drive-palette",
}

export function getItem<T>(key: string, { parseAsJson = true } = {}) : T | null {
    let value = localStorage.getItem(key);
    if(value === null){
        return value;
    }
    if(parseAsJson){
        try{
            value = JSON.parse(value);
        } catch {
            value = null;
            localStorage.removeItem(key);
        }
    }

    return value as T;
}

export const setItem = (key: string, value: string, { parseAsJson = true } = {}) => {
    let valueToBeStored = value;
    if(parseAsJson) {
        valueToBeStored = JSON.stringify(value);
    }
    try {
        localStorage.setItem(key, valueToBeStored);
        window.dispatchEvent(new Event("storage"));
    } catch(e) {
        console.log("Failed to set item in localStorage", e);
    }
};