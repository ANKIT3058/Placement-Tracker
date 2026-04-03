export const generateEventKey = (data: {
  company: string;
  stage: string;
  date: string;
}) => {
  return `${data.company}|${data.stage}|${data.date}`;
};
