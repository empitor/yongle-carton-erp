export type UnitBalance = { unit: string; quantity: string; itemCount: number };
export type BusinessOverview = {
  workbench?: {
    date: string;
    toOrder: number;
    pendingArrivals: number;
    arrivalsToday: number;
    stockedToday: number;
    activeTasks: number;
    tasksToday: number;
    productionToday: number;
    deliveriesToday: number;
    pendingDeliveries: number;
  };
  range: { start: string | null; end: string | null };
  orders: {
    total: number;
    pendingInRange: number;
    pendingAll: number;
    overdueAll: number;
    history: number;
  };
  purchases: {
    total: number;
    pending: number;
    pendingAll: number;
    unknownPrices: number;
    amount: string;
    receivedAmount: string | null;
    outstanding: UnitBalance[];
    recent: {
      id: number;
      number: string;
      supplierName: string;
      orderDate: string;
      status: string;
      businessStatus: string;
      arrivalProgress: string;
      totalAmount: string | null;
    }[];
  };
  inventory: {
    raw: UnitBalance[];
    finished: UnitBalance[];
    rawCount: number;
    finishedCount: number;
    zeroCount: number;
  };
  products: { total: number; incomplete: number };
  movements: {
    id: string;
    itemName: string;
    kind: string;
    action: string;
    date: string;
    delta: string;
    direction: string;
    unit: string;
    actor_name: string;
    purchaseNumber: string | null;
  }[];
  activity: {
    id: string;
    date: string;
    title: string;
    detail: string;
    target: string;
    category: string;
  }[];
};
