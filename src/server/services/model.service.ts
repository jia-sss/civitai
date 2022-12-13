import { MetricTimeframe, ModelStatus, Prisma, ReportReason } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { ModelSort } from '~/server/common/enums';
import { prisma } from '~/server/db/client';
import { GetByIdInput, ReportInput } from '~/server/schema/base.schema';
import { GetAllModelsOutput, ModelInput } from '~/server/schema/model.schema';
import { prepareFile } from '~/utils/file-helpers';

export const getModel = async <TSelect extends Prisma.ModelSelect>({
  input: { id },
  user,
  select,
}: {
  input: GetByIdInput;
  user?: SessionUser;
  select: TSelect;
}) => {
  return await prisma.model.findFirst({
    where: {
      id,
      OR: !user?.isModerator
        ? [{ status: ModelStatus.Published }, { user: { id: user?.id } }]
        : undefined,
    },
    select,
  });
};

export const getModels = async <TSelect extends Prisma.ModelSelect>({
  input: {
    take,
    skip,
    cursor,
    query,
    tag,
    tagname,
    user,
    username,
    types,
    sort,
    period = MetricTimeframe.AllTime,
    rating,
    favorites,
  },
  select,
  user: sessionUser,
  count = false,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page'> & { take?: number; skip?: number };
  select: TSelect;
  user?: SessionUser;
  count?: boolean;
}) => {
  const canViewNsfw = sessionUser?.showNsfw ?? true;
  const where: Prisma.ModelWhereInput = {
    name: query ? { contains: query, mode: 'insensitive' } : undefined,
    tagsOnModels:
      tagname ?? tag
        ? { some: { tag: { name: { equals: tagname ?? tag, mode: 'insensitive' } } } }
        : undefined,
    user: username ?? user ? { username: username ?? user } : undefined,
    type: types?.length ? { in: types } : undefined,
    nsfw: !canViewNsfw ? { equals: false } : undefined,
    rank: rating
      ? {
          AND: [{ ratingAllTime: { gte: rating } }, { ratingAllTime: { lt: rating + 1 } }],
        }
      : undefined,
    OR: !sessionUser?.isModerator
      ? [{ status: ModelStatus.Published }, { user: { id: sessionUser?.id } }]
      : undefined,
    favoriteModels: favorites ? { some: { userId: sessionUser?.id } } : undefined,
  };

  const items = await prisma.model.findMany({
    take,
    skip,
    where,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy: [
      ...(sort === ModelSort.HighestRated ? [{ rank: { [`rating${period}Rank`]: 'asc' } }] : []),
      ...(sort === ModelSort.MostLiked
        ? [{ rank: { [`favoriteCount${period}Rank`]: 'asc' } }]
        : []),
      ...(sort === ModelSort.MostDownloaded
        ? [{ rank: { [`downloadCount${period}Rank`]: 'asc' } }]
        : []),
      ...(sort === ModelSort.MostDiscussed
        ? [{ rank: { [`commentCount${period}Rank`]: 'asc' } }]
        : []),
      { createdAt: 'desc' },
    ],
    select,
  });

  if (count) {
    const count = await prisma.model.count({ where });
    return { items, count };
  }

  return { items };
};

export const getModelVersionsMicro = ({ id }: { id: number }) => {
  return prisma.modelVersion.findMany({
    where: { modelId: id },
    select: { id: true, name: true },
  });
};

export const updateModelById = ({ id, data }: { id: number; data: Prisma.ModelUpdateInput }) => {
  return prisma.model.update({
    where: { id },
    data,
  });
};

export const reportModelById = ({ id, reason, userId }: ReportInput & { userId: number }) => {
  const data: Prisma.ModelUpdateInput =
    reason === ReportReason.NSFW ? { nsfw: true } : { tosViolation: true };

  return prisma.$transaction([
    updateModelById({ id, data }),
    prisma.modelReport.create({
      data: {
        modelId: id,
        reason,
        userId,
      },
    }),
  ]);
};

export const deleteModelById = ({ id }: GetByIdInput) => {
  return prisma.model.delete({ where: { id } });
};

export const createModel = async ({
  modelVersions,
  userId,
  tagsOnModels,
  ...data
}: ModelInput & { userId: number }) => {
  // TODO Cleaning: Merge Add & Update + Transaction
  // Create prisma transaction
  // Upsert Model: separate function
  // Upsert ModelVersions: separate function
  // Upsert Tags: separate function
  // Upsert Images: separate function
  // Upsert ImagesOnModels: separate function
  // Upsert ModelFiles: separate function
  // 👆 Ideally the whole thing will only be this many lines
  //    All of the logic would be in the separate functions
  return prisma.model.create({
    data: {
      ...data,
      userId,
      modelVersions: {
        create: modelVersions.map(({ images, files, ...version }, versionIndex) => ({
          ...version,
          index: versionIndex,
          status: data.status,
          files: files ? { create: files.map(prepareFile) } : undefined,
          images: {
            create: images.map((image, index) => ({
              index,
              image: {
                create: {
                  ...image,
                  userId,
                  meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                },
              },
            })),
          },
        })),
      },
      tagsOnModels: {
        create: tagsOnModels?.map(({ name }) => ({
          tag: {
            connectOrCreate: {
              where: { name },
              create: { name },
            },
          },
        })),
      },
    },
  });
};

export const updateModel = async ({
  id,
  tagsOnModels,
  modelVersions,
  userId,
  ...data
}: ModelInput & { id: number; userId: number }) => {
  const { tagsToCreate, tagsToUpdate } = tagsOnModels?.reduce(
    (acc, current) => {
      if (!current.id) acc.tagsToCreate.push(current);
      else acc.tagsToUpdate.push(current);

      return acc;
    },
    {
      tagsToCreate: [] as Array<typeof tagsOnModels[number]>,
      tagsToUpdate: [] as Array<typeof tagsOnModels[number]>,
    }
  ) ?? { tagsToCreate: [], tagsToUpdate: [] };

  // Get current versions for file and version comparison
  const currentVersions = await prisma.modelVersion.findMany({
    where: { modelId: id },
    select: { id: true, files: { select: { type: true, url: true } } },
  });
  const versionIds = modelVersions.map((version) => version.id).filter(Boolean);
  const versionsToDelete = currentVersions
    .filter((version) => !versionIds.includes(version.id))
    .map(({ id }) => id);

  const model = await prisma.$transaction(
    async (tx) => {
      const imagesToUpdate = modelVersions.flatMap((x) => x.images).filter((x) => !!x.id);
      await Promise.all(
        imagesToUpdate.map(async (image) =>
          tx.image.updateMany({
            where: { id: image.id },
            data: {
              ...image,
              meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
            },
          })
        )
      );

      return tx.model.update({
        where: { id },
        data: {
          ...data,
          status: data.status,
          modelVersions: {
            deleteMany: versionsToDelete.length > 0 ? { id: { in: versionsToDelete } } : undefined,
            upsert: modelVersions.map(
              ({ id = -1, images, files = [], ...version }, versionIndex) => {
                const imagesWithIndex = images.map((image, index) => ({
                  index,
                  userId,
                  ...image,
                  meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                }));
                const existingVersion = currentVersions.find((x) => x.id === id);

                // Determine what files to create/update
                const existingFileUrls: Record<string, string> = {};
                for (const existingFile of existingVersion?.files ?? [])
                  existingFileUrls[existingFile.type] = existingFile.url;

                const filesToCreate: NonNullable<typeof files> = [];
                const filesToUpdate: NonNullable<typeof files> = [];
                for (const file of files) {
                  if (!file.type) continue;
                  const existingUrl = existingFileUrls[file.type];
                  if (!existingUrl) filesToCreate.push(file);
                  else if (existingUrl !== file.url) filesToUpdate.push(file);
                }

                // Determine what images to create/update
                const imagesToUpdate = imagesWithIndex.filter((x) => !!x.id);
                const imagesToCreate = imagesWithIndex.filter((x) => !x.id);

                // TODO Model Status: Allow them to save as draft and publish/unpublish
                return {
                  where: { id },
                  create: {
                    ...version,
                    index: versionIndex,
                    status: data.status,
                    files: {
                      create: filesToCreate.map(prepareFile),
                    },
                    images: {
                      create: imagesWithIndex.map(({ index, ...image }) => ({
                        index,
                        image: { create: image },
                      })),
                    },
                  },
                  update: {
                    ...version,
                    index: versionIndex,
                    epochs: version.epochs ?? null,
                    steps: version.steps ?? null,
                    status: data.status,
                    files: {
                      create: filesToCreate.map(prepareFile),
                      update: filesToUpdate.map(({ type, url, name, sizeKB }) => ({
                        where: { modelVersionId_type: { modelVersionId: id, type } },
                        data: {
                          url,
                          name,
                          sizeKB,
                        },
                      })),
                    },
                    images: {
                      deleteMany: {
                        NOT: images.map((image) => ({ imageId: image.id })),
                      },
                      create: imagesToCreate.map(({ index, ...image }) => ({
                        index,
                        image: { create: image },
                      })),
                      update: imagesToUpdate.map(({ index, ...image }) => ({
                        where: {
                          imageId_modelVersionId: {
                            imageId: image.id as number,
                            modelVersionId: id,
                          },
                        },
                        data: {
                          index,
                        },
                      })),
                    },
                  },
                };
              }
            ),
          },
          tagsOnModels: {
            deleteMany: {},
            connectOrCreate: tagsToUpdate.map((tag) => ({
              where: { modelId_tagId: { modelId: id, tagId: tag.id as number } },
              create: { tagId: tag.id as number },
            })),
            create: tagsToCreate.map((tag) => ({
              tag: { create: { name: tag.name.toLowerCase() } },
            })),
          },
        },
      });
    },
    {
      maxWait: 5000,
      timeout: 10000,
    }
  );

  return model;
};
