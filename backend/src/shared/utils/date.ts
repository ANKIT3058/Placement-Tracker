export const formatDateISTKey = (date: Date) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000; // +5:30 in ms

  const istTime = new Date(date.getTime() + IST_OFFSET);

  return istTime.toISOString().split("T")[0];
};