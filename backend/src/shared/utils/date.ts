export const formatDateISTKey = (date: Date) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000; // +5:30 in ms

  const istTime = new Date(date.getTime() + IST_OFFSET);

  return istTime.toISOString().split("T")[0];
};

export const toUTCDate = (dateStr: string): Date => {
  // Parse YYYY-MM-DD as UTC midnight, not local midnight
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
};

export const toISTKey = (date: Date) => {
  return date.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
};