import type { StoreKey } from "./stores";

export type Offer = {
  externalId: number;
  store: string; // advertiser uniqueName, e.g. 'aldi-nord'
  storeName: string; // advertiser display name
  product: string; // human product text
  price: number; // EUR
  oldPrice: number | null;
  referencePrice: number | null; // per-unit price, e.g. €/kg
  unit: string; // unit shortName, e.g. 'kg', 'St'
  validFrom: string; // ISO date
  validTo: string; // ISO date
};

export type Ingredient = {
  canonical: string;
  qty: number | null;
  unit: string | null;
};

export type Dish = {
  id?: number;
  nameRu: string;
  nameUa: string | null;
  nameDe: string | null;
  cuisine: string; // 'ru' | 'ua'
  course?: "first" | "second" | null; // soup/porridge = first, main = second
  keepsDays?: number; // days the cooked dish keeps; default 1
  tags: string[];
  servings: number;
  ingredients: Ingredient[];
};

export type RankedDish = {
  dish: Dish;
  onOfferCount: number;
  estTotal: number;
  coverage: number; // onOfferCount / ingredientCount, 0..1
};

export type ShoppingItem = {
  ingredient: string;
  store: string;
  product: string;
  price: number;
};

export type MenuDay = { day: number; first: Dish | null; second: Dish | null };
export type WeeklyMenu = { days: MenuDay[] };

export type IntentKind =
  | "suggest"
  | "select_dishes"
  | "add_dishes"
  | "remove_dishes"
  | "add_custom_dish"
  | "scale_dish"
  | "show_menu"
  | "show_list"
  | "help";
export type Intent = { kind: IntentKind; dishNames: string[]; targetServings?: number };

export type StoreGroup = {
  store: StoreKey;
  storeName: string;
  mapsUrl: string;
  items: { ingredient: string; product: string; price: number }[];
};
export type GroupedShoppingList = { groups: StoreGroup[]; missing: string[] };
