export const formatDateISTKey = (date) => {
    const IST_OFFSET = 5.5 * 60 * 60 * 1000; // +5:30 in ms
    const istTime = new Date(date.getTime() + IST_OFFSET);
    return istTime.toISOString().split("T")[0];
};
export const toUTCDate = (dateStr) => {
    // Parse YYYY-MM-DD as UTC midnight, not local midnight
    const [year, month, day] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
};
export const toISTKey = (date) => {
    return date.toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
    });
};
//# sourceMappingURL=date.js.map